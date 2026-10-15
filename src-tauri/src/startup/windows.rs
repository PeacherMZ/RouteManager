use std::{ffi::OsStr, os::windows::ffi::OsStrExt, path::PathBuf};
use windows_sys::Win32::{
    Foundation::*,
    Security::*,
    System::{Com::CoTaskMemFree, Threading::*},
    UI::{Shell::*, WindowsAndMessaging::SW_SHOWNORMAL},
};

struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
fn wide(s: impl AsRef<OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain(Some(0)).collect()
}
fn token(process: HANDLE) -> Result<Handle, String> {
    let mut handle = std::ptr::null_mut();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY | TOKEN_IMPERSONATE, &mut handle) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(Handle(handle))
}
fn elevated() -> Result<bool, String> {
    let token = token(unsafe { GetCurrentProcess() })?;
    let mut info = TOKEN_ELEVATION { TokenIsElevated: 0 };
    let mut len = 0;
    if unsafe {
        GetTokenInformation(
            token.0,
            TokenElevation,
            &mut info as *mut _ as _,
            std::mem::size_of_val(&info) as u32,
            &mut len,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(info.TokenIsElevated != 0)
}
fn quote(arg: &OsStr) -> String {
    let mut result = String::from("\"");
    let mut slashes = 0;
    for c in arg.to_string_lossy().chars() {
        if c == '\\' {
            slashes += 1;
            continue;
        }
        result.extend(std::iter::repeat_n(
            '\\',
            slashes * if c == '"' { 2 } else { 1 },
        ));
        slashes = 0;
        if c == '"' {
            result.push('\\');
        }
        result.push(c);
    }
    result.extend(std::iter::repeat_n('\\', slashes * 2));
    result.push('"');
    result
}
pub fn bootstrap() -> Result<bool, String> {
    if elevated()? {
        validate_origin()?;
        return Ok(false);
    }
    let args: Vec<_> = std::env::args_os().collect();
    if args.iter().any(|a| a == "--origin-pid") {
        return Err("无效的启动上下文".into());
    }
    // Resolve using the original token BEFORE UAC; no file is opened or created.
    // Passing the resolved directory also avoids impersonating another user's token.
    let directory = crate::storage::data_dir()?;
    let parameters = format!(
        "--origin-pid {} --data-dir {}",
        std::process::id(),
        quote(directory.as_os_str())
    );
    let file = wide(std::env::current_exe().map_err(|e| e.to_string())?);
    let params = wide(parameters);
    let verb = wide("runas");
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of_val(&info) as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
    info.lpVerb = verb.as_ptr();
    info.lpFile = file.as_ptr();
    info.lpParameters = params.as_ptr();
    info.nShow = SW_SHOWNORMAL;
    if unsafe { ShellExecuteExW(&mut info) } == 0 {
        if unsafe { GetLastError() } == ERROR_CANCELLED {
            return Ok(true);
        }
        return Err(std::io::Error::last_os_error().to_string());
    }
    let child = Handle(info.hProcess);
    // Keep the original process/token alive until the elevated application exits.
    unsafe {
        WaitForSingleObject(child.0, INFINITE);
    }
    Ok(true)
}
fn validate_origin() -> Result<(), String> {
    let args: Vec<_> = std::env::args_os().collect();
    let origin = args.iter().position(|a| a == "--origin-pid");
    if let Some(index) = origin {
        let pid: u32 = args
            .get(index + 1)
            .and_then(|a| a.to_str())
            .ok_or("启动身份缺失")?
            .parse()
            .map_err(|_| "启动身份无效")?;
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            return Err("无法读取启动者身份，请使用正常启动入口".into());
        }
        let parent = Handle(handle);
        let mut buffer = vec![0u16; 32768];
        let mut len = buffer.len() as u32;
        if unsafe { QueryFullProcessImageNameW(parent.0, 0, buffer.as_mut_ptr(), &mut len) } == 0 {
            return Err("启动者验证失败".into());
        }
        use std::os::windows::ffi::OsStringExt;
        let executable = PathBuf::from(std::ffi::OsString::from_wide(&buffer[..len as usize]));
        if executable.canonicalize().map_err(|e| e.to_string())?
            != std::env::current_exe()
                .map_err(|e| e.to_string())?
                .canonicalize()
                .map_err(|e| e.to_string())?
        {
            return Err("启动者不是本程序，已拒绝切换数据目录".into());
        }
    }
    Ok(())
}
pub fn user_local_directory() -> Result<PathBuf, String> {
    let token = token(unsafe { GetCurrentProcess() })?;
    let mut path = std::ptr::null_mut();
    let status = unsafe { SHGetKnownFolderPath(&FOLDERID_LocalAppData, 0, token.0, &mut path) };
    if status < 0 {
        return Err(format!("无法定位启动者的 LocalAppData：{status:#x}"));
    }
    let result = unsafe {
        let mut len = 0;
        while *path.add(len) != 0 {
            len += 1;
        }
        use std::os::windows::ffi::OsStringExt;
        PathBuf::from(std::ffi::OsString::from_wide(std::slice::from_raw_parts(
            path, len,
        )))
    };
    unsafe {
        CoTaskMemFree(path as _);
    }
    Ok(result)
}
