use crate::model::*;
use crate::routes::normalize_snapshot;
use serde_json::json;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::Duration;

pub trait RouteSystem: Send {
    fn snapshot(&mut self) -> Result<SystemSnapshot, String>;
    fn remove(&mut self, records: &[RouteRecord]) -> Result<(), String>;
    fn add(&mut self, target: &RouteConfig) -> Result<(), String>;
    fn metric(&mut self, records: &[RouteRecord], metric: u16) -> Result<(), String>;
}
#[derive(Default)]
pub struct WindowsRouteSystem {
    worker: Option<PowerShellWorker>,
}
impl WindowsRouteSystem {
    fn request(&mut self, request: serde_json::Value) -> Result<serde_json::Value, String> {
        if self.worker.is_none() {
            let script = format!(
                "$RouteManagerWorker = $true\n{}",
                include_str!("../powershell/routes.ps1")
            );
            self.worker = Some(PowerShellWorker::start(&script)?);
        }
        let response = self
            .worker
            .as_mut()
            .unwrap()
            .request(request, Duration::from_secs(45));
        // A transport failure has an unknown outcome. Discard the process, never replay a mutation.
        if response.is_err() {
            self.worker = None;
        }
        let envelope = response?;
        if envelope["ok"] != true {
            return Err(envelope["error"]
                .as_str()
                .unwrap_or("系统路由操作失败")
                .into());
        }
        Ok(envelope["data"].clone())
    }
}
impl RouteSystem for WindowsRouteSystem {
    fn snapshot(&mut self) -> Result<SystemSnapshot, String> {
        let value = self.request(json!({"action": "snapshot"}))?;
        let mut snapshot: SystemSnapshot =
            serde_json::from_value(value).map_err(|e| format!("路由数据格式错误：{e}"))?;
        normalize_snapshot(&mut snapshot)?;
        Ok(snapshot)
    }
    fn remove(&mut self, records: &[RouteRecord]) -> Result<(), String> {
        self.request(json!({"action":"remove","records":records}))?;
        Ok(())
    }
    fn add(&mut self, target: &RouteConfig) -> Result<(), String> {
        self.request(json!({"action":"add","target":target}))?;
        Ok(())
    }
    fn metric(&mut self, records: &[RouteRecord], metric: u16) -> Result<(), String> {
        self.request(json!({"action":"metric","records":records,"metric":metric}))?;
        Ok(())
    }
}
struct PowerShellWorker {
    child: Child,
    input: Option<Sender<String>>,
    output: Receiver<Result<serde_json::Value, String>>,
    io_thread: Option<std::thread::JoinHandle<()>>,
}
impl PowerShellWorker {
    fn start(script: &str) -> Result<Self, String> {
        if !cfg!(windows) {
            return Err("系统路由操作仅支持 Windows".into());
        }
        use base64::Engine;
        let utf16: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
        let encoded = base64::engine::general_purpose::STANDARD.encode(utf16);
        let windows = std::env::var_os("SystemRoot").ok_or("未找到 Windows 系统目录")?;
        let program = std::path::PathBuf::from(windows)
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let mut command = Command::new(program);
        command
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                &encoded,
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("无法启动 Windows PowerShell：{e}"))?;
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let (input, requests) = mpsc::channel::<String>();
        let (responses, output) = mpsc::channel();
        // Pipe IO runs on a worker thread so the timeout also covers a blocked stdin write.
        let io_thread = std::thread::spawn(move || {
            for request in requests {
                let result = (|| {
                    writeln!(stdin, "{request}").map_err(|e| e.to_string())?;
                    stdin.flush().map_err(|e| e.to_string())?;
                    let mut line = String::new();
                    if stdout.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
                        return Err("PowerShell 进程已退出；操作结果未知，请刷新核对".into());
                    }
                    serde_json::from_str(line.trim().trim_start_matches('\u{feff}'))
                        .map_err(|e| format!("PowerShell 响应格式错误：{e}"))
                })();
                let failed = result.is_err();
                if responses.send(result).is_err() || failed {
                    break;
                }
            }
        });
        Ok(Self {
            child,
            input: Some(input),
            output,
            io_thread: Some(io_thread),
        })
    }
    fn request(
        &mut self,
        request: serde_json::Value,
        timeout: Duration,
    ) -> Result<serde_json::Value, String> {
        self.input
            .as_ref()
            .ok_or("系统接口已关闭")?
            .send(request.to_string())
            .map_err(|_| "系统接口已退出，请刷新核对")?;
        self.output.recv_timeout(timeout).map_err(|_| {
            "系统操作超时或接口已断开；状态可能已变化，请刷新核对，不能视为未执行".to_string()
        })?
    }
}
impl Drop for PowerShellWorker {
    fn drop(&mut self) {
        self.input.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(thread) = self.io_thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    const ECHO: &str = r#"
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
while ($null -ne ($line = [Console]::In.ReadLine())) {
    $request = $line | ConvertFrom-Json
    if ($request.action -eq 'exit') { exit 1 }
    if ($request.action -eq 'wait') { Start-Sleep -Seconds 10 }
    if ($request.action -eq 'bad') { [Console]::Out.WriteLine('invalid'); continue }
    [Console]::Out.WriteLine((@{ok=$true; data=@{pid=$PID; text=$request.text}} | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
}
"#;
    #[test]
    fn worker_reuses_process_and_preserves_json_unicode() {
        let mut worker = PowerShellWorker::start(ECHO).unwrap();
        let first = worker
            .request(json!({"text":"中文\n\"路由\""}), Duration::from_secs(10))
            .unwrap();
        let second = worker
            .request(json!({"text":"next"}), Duration::from_secs(10))
            .unwrap();
        assert_eq!(first["data"]["text"], "中文\n\"路由\"");
        assert_eq!(first["data"]["pid"], second["data"]["pid"]);
    }
    #[test]
    fn worker_reports_exit_invalid_output_and_timeout() {
        for action in ["exit", "bad", "wait"] {
            let mut worker = PowerShellWorker::start(ECHO).unwrap();
            worker
                .request(json!({"text":"ready"}), Duration::from_secs(10))
                .unwrap();
            let start = std::time::Instant::now();
            assert!(worker
                .request(json!({"action":action}), Duration::from_millis(150))
                .is_err());
            drop(worker);
            assert!(start.elapsed() < Duration::from_secs(5));
        }
    }
}
