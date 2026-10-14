use route_manager::{
    db::Database,
    model::*,
    routes::build_snapshot,
    system::{RouteSystem, WindowsRouteSystem},
};
fn main() -> Result<(), String> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let directory = std::env::args()
        .nth(1)
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| root.join("data"));
    let db = Database::open(&directory, Some(&root.join("legacy/routes.yaml")))?;
    let library = db.library()?;
    let mut system = WindowsRouteSystem::default();
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
