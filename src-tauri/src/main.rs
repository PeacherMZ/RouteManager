#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use route_manager::{db::Database, hosts, model::*, service::AppService, system::native_system};
use std::sync::{Arc, Mutex};
use tauri::State;

type Shared = Arc<Mutex<AppService>>;
async fn run<T: Send + 'static>(
    state: State<'_, Shared>,
    work: impl FnOnce(&mut AppService) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let shared = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut app = shared.lock().map_err(|_| "程序状态锁已失效，请重新启动")?;
        work(&mut app)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn get_snapshot(state: State<'_, Shared>) -> Result<RouteSnapshot, String> {
    run(state, |app| app.snapshot()).await
}
#[tauri::command]
async fn get_library(state: State<'_, Shared>) -> Result<Library, String> {
    run(state, |app| app.db.library()).await
}
#[tauri::command]
async fn save_library(state: State<'_, Shared>, library: Library) -> Result<Library, String> {
    run(state, move |app| {
        app.pending = None;
        app.db.save_library(library)
    })
    .await
}
#[tauri::command]
async fn preview_operation(
    state: State<'_, Shared>,
    request: PlanRequest,
) -> Result<OperationPlan, String> {
    run(state, move |app| app.plan(request)).await
}
#[tauri::command]
async fn execute_operation(
    state: State<'_, Shared>,
    id: String,
) -> Result<OperationResult, String> {
    run(state, move |app| app.execute(&id)).await
}
#[tauri::command]
async fn get_history(state: State<'_, Shared>) -> Result<Vec<OperationResult>, String> {
    run(state, |app| app.db.history()).await
}
#[tauri::command]
async fn import_yaml(state: State<'_, Shared>, text: String) -> Result<Library, String> {
    run(state, move |app| {
        app.pending = None;
        app.db.import(&text)
    })
    .await
}
#[tauri::command]
async fn export_yaml(state: State<'_, Shared>) -> Result<String, String> {
    run(state, |app| app.db.export()).await
}
#[tauri::command]
async fn read_hosts(state: State<'_, Shared>) -> Result<HostsDocument, String> {
    run(state, |_| hosts::read(&hosts::system_hosts_path()?)).await
}
#[tauri::command]
async fn save_hosts(
    state: State<'_, Shared>,
    content: String,
    fingerprint: String,
) -> Result<HostsDocument, String> {
    run(state, move |app| {
        hosts::save(
            &hosts::system_hosts_path()?,
            &app.db.data_dir,
            &content,
            &fingerprint,
        )
    })
    .await
}
#[tauri::command]
async fn get_settings(state: State<'_, Shared>) -> Result<serde_json::Value, String> {
    run(state, |app| Ok(serde_json::json!({
        "theme": app.db.get_setting("theme")?.unwrap_or(serde_json::json!("system")),
        "refresh_seconds": app.db.get_setting("refresh_seconds")?.unwrap_or(serde_json::json!(5)),
        "data_dir": app.db.data_dir,
        "version": env!("CARGO_PKG_VERSION"),
        "backups_dir": app.db.data_dir.join("backups"),
        "exports_dir": app.db.data_dir.join("exports"),
        "platform": route_manager::system::platform_info()
    }))).await
}
#[tauri::command]
async fn save_setting(
    state: State<'_, Shared>,
    key: String,
    value: serde_json::Value,
) -> Result<(), String> {
    run(state, move |app| {
        match key.as_str() {
            "theme" if matches!(value.as_str(), Some("light" | "dark" | "system")) => {}
            "refresh_seconds" if matches!(value.as_u64(), Some(0 | 5 | 10 | 30)) => {}
            _ => return Err("无效设置".into()),
        }
        app.db.set_setting(&key, &value)
    })
    .await
}
#[cfg(windows)]
fn message(text: &str) {
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(
            hwnd: *mut std::ffi::c_void,
            text: *const u16,
            caption: *const u16,
            kind: u32,
        ) -> i32;
    }
    let content: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
    let title: Vec<u16> = "路由管理器".encode_utf16().chain(Some(0)).collect();
    unsafe {
        MessageBoxW(std::ptr::null_mut(), content.as_ptr(), title.as_ptr(), 0x10);
    }
}
#[cfg(not(windows))]
fn message(text: &str) {
    eprintln!("{text}");
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("/usr/bin/osascript").args(["-e", "on run argv\n display alert \"路由管理器\" message (item 1 of argv) as critical\nend run", "--", text]).status();
    }
}

fn main() {
    match route_manager::startup::bootstrap() {
        Ok(true) => return,
        Ok(false) => {}
        Err(error) => {
            message(&error);
            return;
        }
    }
    let directory = match route_manager::storage::data_dir() {
        Ok(path) => path,
        Err(error) => {
            message(&error);
            return;
        }
    };
    let _instance = match route_manager::storage::InstanceLock::acquire(&directory) {
        Ok(lock) => lock,
        Err(error) => {
            message(&error);
            return;
        }
    };
    let init = (|| -> Result<AppService, String> {
        let db = Database::open(&directory, None)?;
        Ok(AppService {
            db,
            system: native_system(),
            pending: None,
        })
    })();
    let app = match init {
        Ok(app) => app,
        Err(error) => {
            message(&format!("启动失败：{error}"));
            return;
        }
    };
    let result = tauri::Builder::default()
        .manage(Arc::new(Mutex::new(app)))
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            get_library,
            save_library,
            preview_operation,
            execute_operation,
            get_history,
            import_yaml,
            export_yaml,
            read_hosts,
            save_hosts,
            get_settings,
            save_setting
        ])
        .run(tauri::generate_context!());
    if let Err(error) = result {
        message(&format!("程序运行失败：{error}"));
    }
}
