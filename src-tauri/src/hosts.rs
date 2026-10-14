use crate::model::{hash, HostsDocument};
use std::path::{Path, PathBuf};

pub fn system_hosts_path() -> Result<PathBuf, String> {
    Ok(
        PathBuf::from(std::env::var_os("SystemRoot").ok_or("找不到 Windows 目录")?)
            .join("System32/drivers/etc/hosts"),
    )
}
fn ansi_encoding() -> Result<&'static encoding_rs::Encoding, String> {
    #[cfg(windows)]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn GetACP() -> u32;
        }
        let code = unsafe { GetACP() };
        let encoding = match code {
            65001 => Some(encoding_rs::UTF_8),
            936 => Some(encoding_rs::GBK),
            950 => Some(encoding_rs::BIG5),
            932 => Some(encoding_rs::SHIFT_JIS),
            949 => Some(encoding_rs::EUC_KR),
            _ => encoding_rs::Encoding::for_label(format!("windows-{code}").as_bytes()),
        };
        encoding.ok_or_else(|| format!("不支持的系统代码页 {code}；请先将 hosts 转为 UTF-8"))
    }
    #[cfg(not(windows))]
    {
        Ok(encoding_rs::WINDOWS_1252)
    }
}
fn decode(bytes: &[u8]) -> Result<(String, String), String> {
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        return Ok((
            String::from_utf8(bytes[3..].to_vec()).map_err(|e| e.to_string())?,
            "UTF-8 BOM".into(),
        ));
    }
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        let little = bytes[0] == 0xff;
        if bytes.len() % 2 != 0 {
            return Err("UTF-16 文件长度无效".into());
        }
        let words: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| {
                if little {
                    u16::from_le_bytes([c[0], c[1]])
                } else {
                    u16::from_be_bytes([c[0], c[1]])
                }
            })
            .collect();
        return Ok((
            String::from_utf16(&words).map_err(|e| e.to_string())?,
            if little { "UTF-16 LE" } else { "UTF-16 BE" }.into(),
        ));
    }
    if let Ok(text) = std::str::from_utf8(bytes) {
        return Ok((text.into(), "UTF-8".into()));
    }
    let encoding = ansi_encoding()?;
    let (text, _, errors) = encoding.decode(bytes);
    if errors {
        return Err("无法无损解码 hosts，未打开可写编辑".into());
    }
    Ok((text.into_owned(), encoding.name().into()))
}
fn encode(text: &str, encoding: &str) -> Result<Vec<u8>, String> {
    match encoding {
        "UTF-8" => Ok(text.as_bytes().to_vec()),
        "UTF-8 BOM" => Ok([vec![0xef, 0xbb, 0xbf], text.as_bytes().to_vec()].concat()),
        "UTF-16 LE" | "UTF-16 BE" => {
            let little = encoding == "UTF-16 LE";
            let mut result = if little {
                vec![0xff, 0xfe]
            } else {
                vec![0xfe, 0xff]
            };
            for unit in text.encode_utf16() {
                result.extend(if little {
                    unit.to_le_bytes()
                } else {
                    unit.to_be_bytes()
                });
            }
            Ok(result)
        }
        _ => {
            let encoding = encoding_rs::Encoding::for_label(encoding.as_bytes())
                .ok_or("不支持的 hosts 编码")?;
            let (bytes, _, errors) = encoding.encode(text);
            if errors {
                return Err("新增字符无法以原编码保存，未修改 hosts".into());
            }
            Ok(bytes.into_owned())
        }
    }
}
pub fn read(path: &Path) -> Result<HostsDocument, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("hosts 文件大于 2 MB".into());
    }
    let (content, encoding) = decode(&bytes)?;
    let newline = if content.contains("\r\n") {
        "CRLF"
    } else {
        "LF"
    }
    .into();
    Ok(HostsDocument {
        content,
        fingerprint: hash(&bytes),
        encoding,
        newline,
        path: path.display().to_string(),
    })
}
pub fn save(
    path: &Path,
    data_dir: &Path,
    content: &str,
    expected: &str,
) -> Result<HostsDocument, String> {
    if content.len() > 2 * 1024 * 1024 || content.contains('\0') {
        return Err("hosts 内容过大或包含空字符".into());
    }
    let original = read(path)?;
    if original.fingerprint != expected {
        return Err("hosts 已被其他程序修改，请重新读取后再保存".into());
    }
    let normalized = content.replace("\r\n", "\n").replace('\r', "\n");
    let text = if original.newline == "CRLF" {
        normalized.replace('\n', "\r\n")
    } else {
        normalized
    };
    let bytes = encode(&text, &original.encoding)?;
    let backup = data_dir
        .join("backups")
        .join(format!("hosts-{}.bak", uuid::Uuid::new_v4()));
    std::fs::copy(path, backup).map_err(|e| format!("备份 hosts 失败，未修改：{e}"))?;
    let temp = path.with_file_name(format!(".hosts-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        if read(path)?.fingerprint != expected {
            return Err("保存期间 hosts 发生变化，未覆盖".into());
        }
        replace_file(&temp, path)?;
        read(path)
    })();
    if temp.exists() {
        let _ = std::fs::remove_file(temp);
    }
    result
}
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        extern "system" {
            fn ReplaceFileW(
                replaced: *const u16,
                replacement: *const u16,
                backup: *const u16,
                flags: u32,
                exclude: *mut std::ffi::c_void,
                reserved: *mut std::ffi::c_void,
            ) -> i32;
        }
        let to: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        let from: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe {
            ReplaceFileW(
                to.as_ptr(),
                from.as_ptr(),
                std::ptr::null(),
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(format!(
                "无法原子替换 hosts：{}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        std::fs::rename(source, destination).map_err(|e| e.to_string())
    }
}
