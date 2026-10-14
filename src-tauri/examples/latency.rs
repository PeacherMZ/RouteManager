// Read-only benchmark: no database and no route writes.
use route_manager::system::{RouteSystem, WindowsRouteSystem};
use std::time::Instant;
fn main() -> Result<(), String> {
    let mut system = WindowsRouteSystem::default();
    for sample in 0..6 {
        let start = Instant::now();
        let snapshot = system.snapshot()?;
        println!(
            "sample={sample} elapsed_ms={} records={}",
            start.elapsed().as_millis(),
            snapshot.routes.len()
        );
    }
    Ok(())
}
