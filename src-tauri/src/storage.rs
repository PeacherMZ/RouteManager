use std::path::PathBuf;
pub const APP_ID: &str = "com.local.route-manager";

pub fn explicit_directory(args: &[std::ffi::OsString]) -> Result<Option<PathBuf>, String> {
    let indexes: Vec<_> = args
        .iter()
        .enumerate()
        .filter(|(_, a)| *a == "--data-dir")
        .map(|(i, _)| i)
        .collect();
    if indexes.len() > 1 {
        return Err("--data-dir 不能重复".into());
    }
    if let Some(index) = indexes.first() {
        let path = PathBuf::from(args.get(index + 1).ok_or("--data-dir 后缺少目录")?);
        if !path.is_absolute() {
            return Err("--data-dir 必须是绝对路径".into());
        }
        return Ok(Some(path));
    }
    Ok(None)
}
pub fn data_dir() -> Result<PathBuf, String> {
    let args: Vec<_> = std::env::args_os().collect();
    if let Some(path) = explicit_directory(&args)? {
        return Ok(path);
    }
    #[cfg(windows)]
    let base = crate::startup::user_local_directory()?;
    #[cfg(not(windows))]
    let base = dirs::data_local_dir().ok_or("无法定位用户数据目录")?;
    Ok(base.join(if cfg!(debug_assertions) {
        "com.local.route-manager.dev"
    } else {
        APP_ID
    }))
}

/// An OS-held file lock, released on crash; never delete the lock file while held.
pub struct InstanceLock(std::fs::File);
impl InstanceLock {
    pub fn acquire(directory: &std::path::Path) -> Result<Self, String> {
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(directory)
            .map_err(|e| format!("数据目录不可写：{e}"))?;
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(directory.join("instance.lock"))
            .map_err(|e| e.to_string())?;
        file.try_lock()
            .map_err(|_| "此数据目录已由另一个路由管理器使用".to_string())?;
        Ok(Self(file))
    }
}
impl Drop for InstanceLock {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}
