use super::RouteSystem;
use crate::{model::*, routes::normalize_snapshot};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    os::unix::{
        fs::PermissionsExt,
        io::AsRawFd,
        net::{UnixListener, UnixStream},
    },
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

fn helper() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let directory = exe.parent().ok_or("无法定位原生助手")?;
    let bundled = directory.join("../Resources/route-manager-helper");
    if bundled.is_file() {
        return bundled.canonicalize().map_err(|e| e.to_string());
    }
    let development = directory.join("route-manager-helper");
    if cfg!(debug_assertions) && development.is_file() {
        return Ok(development);
    }
    Err("原生助手缺失，请重新安装完整应用".into())
}
fn envelope(value: Value) -> Result<Value, String> {
    if value["ok"] == true {
        Ok(value["data"].clone())
    } else {
        Err(value["error"]
            .as_str()
            .unwrap_or("macOS 系统操作失败")
            .into())
    }
}
#[derive(Default)]
pub struct MacRouteSystem {
    session: Option<Session>,
}
impl RouteSystem for MacRouteSystem {
    fn snapshot(&mut self) -> Result<SystemSnapshot, String> {
        let mut command = Command::new(helper()?);
        command.arg("snapshot");
        let output = command.output().map_err(|e| e.to_string())?;
        let value = envelope(serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?)?;
        if !output.status.success() {
            return Err("macOS 路由快照读取失败".into());
        }
        let mut snapshot = serde_json::from_value(value).map_err(|e| e.to_string())?;
        normalize_snapshot(&mut snapshot)?;
        Ok(snapshot)
    }
    fn begin_operation(&mut self) -> Result<(), String> {
        if self.session.is_none() {
            self.session = Some(Session::start()?);
        }
        Ok(())
    }
    fn end_operation(&mut self) {
        self.session.take();
    }
    fn add(&mut self, target: &RouteConfig) -> Result<(), String> {
        self.request(json!({"action":"add", "target":target}))?;
        // configd applies persisted settings asynchronously. Poll facts, never repeat the write.
        for _ in 0..20 {
            if crate::routes::target_satisfied(&self.snapshot()?, target) {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        Err("系统已接受请求，但活动/持久记录尚未通过核验，请刷新检查".into())
    }
    fn remove(&mut self, records: &[RouteRecord]) -> Result<(), String> {
        self.request(json!({"action":"remove", "records":records}))
            .map(|_| ())
    }
    fn metric(&mut self, _: &[RouteRecord], _: u16) -> Result<(), String> {
        Err("macOS 不支持 Windows 路由 metric".into())
    }
}
impl MacRouteSystem {
    fn request(&mut self, value: Value) -> Result<Value, String> {
        self.session
            .as_mut()
            .ok_or("系统修改尚未授权")?
            .request(value)
    }
}
pub fn replace_hosts(bytes: &[u8], fingerprint: &str) -> Result<(), String> {
    use base64::Engine;
    let mut session = Session::start()?;
    session.request(json!({"action":"hosts", "bytes":base64::engine::general_purpose::STANDARD.encode(bytes), "fingerprint":fingerprint}))?;
    Ok(())
}
struct Session {
    stream: BufReader<UnixStream>,
    child: Child,
    directory: PathBuf,
    failed: bool,
}
impl Session {
    fn start() -> Result<Self, String> {
        // Short socket path independent of a possibly very long Unicode user home.
        let directory =
            PathBuf::from("/tmp").join(format!("route-manager-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).map_err(|e| e.to_string())?;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
        let path = directory.join("ipc");
        let result = (|| {
            let listener = UnixListener::bind(&path).map_err(|e| e.to_string())?;
            listener.set_nonblocking(true).map_err(|e| e.to_string())?;
            // The script is fixed. Only generated paths are shell-quoted, never request content.
            let script = "on run argv\n do shell script ((quoted form of (item 1 of argv)) & \" serve \" & (quoted form of (item 2 of argv)) & \" \" & (quoted form of (item 3 of argv))) with administrator privileges\nend run";
            let mut child = Command::new("/usr/bin/osascript")
                .args(["-e", script, "--"])
                .arg(helper()?)
                .arg(&path)
                .arg(std::process::id().to_string())
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| e.to_string())?;
            let start = Instant::now();
            loop {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let mut uid = 0;
                        let mut gid = 0;
                        if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0
                            || uid != 0
                        {
                            drop(stream);
                            continue;
                        }
                        stream
                            .set_read_timeout(Some(Duration::from_secs(45)))
                            .map_err(|e| e.to_string())?;
                        stream
                            .set_write_timeout(Some(Duration::from_secs(45)))
                            .map_err(|e| e.to_string())?;
                        return Ok(Self {
                            stream: BufReader::new(stream),
                            child,
                            directory: directory.clone(),
                            failed: false,
                        });
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(e) => {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(e.to_string());
                    }
                }
                if child.try_wait().map_err(|e| e.to_string())?.is_some() {
                    return Err("管理员授权已取消或原生助手无法启动，未执行请求".into());
                }
                if start.elapsed() > Duration::from_secs(120) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("管理员授权超时，未执行请求".into());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::remove_dir(&directory);
        }
        result
    }
    fn request(&mut self, request: Value) -> Result<Value, String> {
        if self.failed {
            return Err("助手连接已失效，请刷新核对；不会重放写入".into());
        }
        let transport = (|| -> Result<Value, String> {
            writeln!(self.stream.get_mut(), "{request}").map_err(|e| e.to_string())?;
            self.stream.get_mut().flush().map_err(|e| e.to_string())?;
            let mut line = String::new();
            // Bound a malformed helper response rather than allocating without limit.
            let count = std::io::Read::take(&mut self.stream, 16 * 1024 * 1024)
                .read_line(&mut line)
                .map_err(|e| e.to_string())?;
            if count == 0 || !line.ends_with('\n') {
                return Err("原生助手响应中断".into());
            }
            serde_json::from_str(&line).map_err(|e| e.to_string())
        })();
        match transport {
            Ok(value) => envelope(value),
            Err(error) => {
                self.failed = true;
                let _ = self.stream.get_mut().shutdown(std::net::Shutdown::Both);
                Err(format!("{error}；操作结果未知，请刷新核对，不能自动重试"))
            }
        }
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.stream.get_mut().shutdown(std::net::Shutdown::Both);
        // EOF makes the authenticated helper exit; osascript is only its waiting parent.
        let start = Instant::now();
        while matches!(self.child.try_wait(), Ok(None)) && start.elapsed() < Duration::from_secs(2)
        {
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(self.directory.join("ipc"));
        let _ = std::fs::remove_dir(&self.directory);
    }
}
