use crate::model::*;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::WindowsRouteSystem;
#[cfg(target_os = "macos")]
pub mod macos;

pub trait RouteSystem: Send {
    fn snapshot(&mut self) -> Result<SystemSnapshot, String>;
    fn remove(&mut self, records: &[RouteRecord]) -> Result<(), String>;
    fn add(&mut self, target: &RouteConfig) -> Result<(), String>;
    fn metric(&mut self, records: &[RouteRecord], metric: u16) -> Result<(), String>;
    fn begin_operation(&mut self) -> Result<(), String> {
        Ok(())
    }
    fn end_operation(&mut self) {}
}
pub fn native_system() -> Box<dyn RouteSystem> {
    #[cfg(windows)]
    {
        Box::new(WindowsRouteSystem::default())
    }
    #[cfg(target_os = "macos")]
    {
        Box::new(macos::MacRouteSystem::default())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        compile_error!("Only Windows and macOS are supported");
    }
}
#[derive(serde::Serialize)]
pub struct PlatformInfo {
    pub os: &'static str,
    pub route_write: bool,
    pub persistent_routes: bool,
    pub metric: bool,
    pub privilege: &'static str,
}
pub fn platform_info() -> PlatformInfo {
    PlatformInfo {
        os: if cfg!(windows) { "windows" } else { "macos" },
        route_write: true,
        persistent_routes: true,
        metric: cfg!(windows),
        privilege: if cfg!(windows) {
            "startup"
        } else {
            "on_demand"
        },
    }
}
