use route_manager::{db::Database, model::*, routes::build_snapshot, system::native_system};
fn main() -> Result<(), String> {
    let directory = std::env::args_os()
        .nth(1)
        .map(std::path::PathBuf::from)
        .ok_or("必须显式指定独立诊断数据目录")?;
    if !directory.is_absolute() {
        return Err("诊断目录必须是绝对路径".into());
    }
    let _lock = route_manager::storage::InstanceLock::acquire(&directory)?;
    let db = Database::open(&directory, None)?;
    let library = db.library()?;
    let mut system = native_system();
    let raw = system.snapshot()?;
    let snapshot = build_snapshot(&raw, &library, &db.created_keys()?);
    let active = raw
        .routes
        .iter()
        .filter(|r| r.store == "ActiveStore")
        .count();
    let persistent = raw
        .routes
        .iter()
        .filter(|r| r.store == "PersistentStore")
        .count();
    let summary = serde_json::json!({"captured_at":now(),"config_routes":library.routes.len(),"groups":library.groups.len(),
        "active_records":active,"persistent_records":persistent,"interfaces":raw.interfaces.len(),
        "managed":snapshot.routes.iter().filter(|r|r.ownership=="managed").count(),
        "ambiguous_configs":snapshot.matches.iter().filter(|m|m.state=="ambiguous").count()});
    println!("{}", serde_json::to_string_pretty(&summary).unwrap());
    Ok(())
}
