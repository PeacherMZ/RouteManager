//! Stable, platform-qualified interface references. BSD names are not GUIDs.
pub fn normalize(value: &str) -> Result<String, String> {
    let value = value.trim();
    if let Some(rest) = value.strip_prefix("macos:") {
        let (device, service) = rest.split_once(':').ok_or("macOS 接口标识无效")?;
        if device.is_empty()
            || device.len() > 15
            || !device.bytes().all(|c| c.is_ascii_alphanumeric())
        {
            return Err("macOS 接口名称无效".into());
        }
        let service = if service == "-" {
            "-".into()
        } else {
            uuid::Uuid::parse_str(service)
                .map_err(|_| "网络服务 UUID 无效")?
                .to_string()
        };
        return Ok(format!("macos:{device}:{service}"));
    }
    let guid = value
        .strip_prefix("windows:")
        .unwrap_or(value)
        .trim_matches(|c| c == '{' || c == '}');
    Ok(format!(
        "windows:{}",
        uuid::Uuid::parse_str(guid).map_err(|_| "网卡 GUID 无效")?
    ))
}
pub fn is_macos(id: &str) -> bool {
    id.starts_with("macos:")
}
pub fn matches(a: &str, b: &str) -> bool {
    if is_macos(a) || is_macos(b) {
        a == b
    } else {
        a.eq_ignore_ascii_case(b)
    }
}
pub fn validate_target(id: &str, metric: Option<u16>, persistent: bool) -> Result<(), String> {
    if is_macos(id) {
        if metric.is_some() {
            return Err("macOS 不支持 Windows 路由 metric；请清空 metric".into());
        }
        if persistent && id.ends_with(":-") {
            return Err("此接口没有唯一的原生网络服务，不支持重启持久化".into());
        }
    }
    Ok(())
}
