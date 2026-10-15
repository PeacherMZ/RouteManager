// Read-only benchmark: no database and no route writes.
use route_manager::system::native_system;
use std::time::Instant;
fn main() -> Result<(), String> {
    let mut system = native_system();
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
