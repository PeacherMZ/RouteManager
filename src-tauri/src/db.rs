use crate::model::*;
use crate::routes::validate_library;
use rusqlite::{params, Connection, OptionalExtension, MAIN_DB};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub struct Database {
    pub connection: Connection,
    pub data_dir: PathBuf,
}
impl Database {
    pub fn open(data_dir: &Path, legacy_yaml: Option<&Path>) -> Result<Self, String> {
        std::fs::create_dir_all(data_dir).map_err(|e| format!("数据目录不可写：{e}"))?;
        for folder in ["backups", "exports"] {
            std::fs::create_dir_all(data_dir.join(folder)).map_err(|e| e.to_string())?;
        }
        let mut db = Self {
            connection: Connection::open(data_dir.join("routes.db")).map_err(|e| e.to_string())?,
            data_dir: data_dir.to_path_buf(),
        };
        db.connection
            .execute_batch(
                "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;",
            )
            .map_err(|e| e.to_string())?;
        let version: i32 = db
            .connection
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if version > 1 {
            return Err("数据库版本比本程序更新，不能降级打开".into());
        }
        if version == 0 {
            db.backup("schema")?;
            db.connection
                .execute_batch(include_str!("../migrations/001.sql"))
                .map_err(|e| e.to_string())?;
        }
        if db.get_setting("legacy_imported")?.is_none() {
            let source = legacy_yaml.filter(|p| p.exists());
            let library = match source {
                Some(path) => {
                    parse_yaml(&std::fs::read_to_string(path).map_err(|e| e.to_string())?)?
                }
                None => Library::default(),
            };
            let tx = db.connection.transaction().map_err(|e| e.to_string())?;
            write_library(&tx, &library)?;
            tx.execute(
                "INSERT INTO settings(key,value) VALUES('legacy_imported',?1)",
                [serde_json::to_string(&source.map(|p| p.display().to_string())).unwrap()],
            )
            .map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
        }
        // A process termination must never turn an unverified operation into a success.
        for mut operation in db.history()? {
            if operation.status == "running" {
                operation.status = "interrupted".into();
                operation.finished_at = now();
                db.record(&operation)?;
            }
        }
        Ok(db)
    }
    pub fn backup(&self, label: &str) -> Result<String, String> {
        let path = self.data_dir.join("backups").join(format!(
            "{}-{}-{}.db",
            label,
            chrono::Utc::now().format("%Y%m%d-%H%M%S"),
            uuid::Uuid::new_v4()
        ));
        self.connection
            .backup(MAIN_DB, &path, None)
            .map_err(|e| e.to_string())?;
        Ok(path.display().to_string())
    }
    pub fn library(&self) -> Result<Library, String> {
        let mut route_stmt = self
            .connection
            .prepare("SELECT body FROM route_configs ORDER BY position")
            .map_err(|e| e.to_string())?;
        let route_strings = route_stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut routes = Vec::new();
        for value in route_strings {
            routes.push(
                serde_json::from_str(&value.map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?,
            );
        }
        let mut group_stmt = self
            .connection
            .prepare("SELECT id,name FROM route_groups ORDER BY position")
            .map_err(|e| e.to_string())?;
        let groups_iter = group_stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        let mut groups = Vec::new();
        for value in groups_iter {
            let (id, name) = value.map_err(|e| e.to_string())?;
            let mut members_stmt = self
                .connection
                .prepare("SELECT route_id FROM group_members WHERE group_id=?1 ORDER BY position")
                .map_err(|e| e.to_string())?;
            let members = members_stmt
                .query_map([&id], |r| r.get(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<String>, _>>()
                .map_err(|e| e.to_string())?;
            groups.push(RouteGroup {
                id,
                name,
                routes: members,
            });
        }
        Ok(Library { routes, groups })
    }
    pub fn save_library(&mut self, mut library: Library) -> Result<Library, String> {
        validate_library(&mut library)?;
        let tx = self.connection.transaction().map_err(|e| e.to_string())?;
        write_library(&tx, &library)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(library)
    }
    pub fn save_route(&mut self, route: RouteConfig) -> Result<(), String> {
        let mut library = self.library()?;
        if let Some(existing) = library
            .routes
            .iter_mut()
            .find(|c| c.id.eq_ignore_ascii_case(&route.id))
        {
            *existing = route;
        } else {
            library.routes.push(route);
        }
        self.save_library(library)?;
        Ok(())
    }
    pub fn import(&mut self, text: &str) -> Result<Library, String> {
        let imported = parse_yaml(text)?;
        self.backup("before-import")?;
        self.save_library(imported)
    }
    pub fn export(&self) -> Result<String, String> {
        let library = self.library()?;
        let document = ExportDocument {
            version: 2,
            routes: library.routes,
            groups: library.groups,
        };
        let yaml = serde_yaml::to_string(&document).map_err(|e| e.to_string())?;
        let path = self.data_dir.join("exports").join(format!(
            "routes-{}.yaml",
            chrono::Utc::now().format("%Y%m%d-%H%M%S")
        ));
        std::fs::write(&path, yaml).map_err(|e| e.to_string())?;
        Ok(path.display().to_string())
    }
    pub fn get_setting(&self, key: &str) -> Result<Option<serde_json::Value>, String> {
        let value: Option<String> = self
            .connection
            .query_row("SELECT value FROM settings WHERE key=?1", [key], |r| {
                r.get(0)
            })
            .optional()
            .map_err(|e| e.to_string())?;
        value
            .map(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
            .transpose()
    }
    pub fn set_setting(&self, key: &str, value: &serde_json::Value) -> Result<(), String> {
        self.connection.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value.to_string()]).map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn record(&self, operation: &OperationResult) -> Result<(), String> {
        self.connection.execute("INSERT INTO operations(id,started_at,body) VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
            params![operation.id, operation.started_at, serde_json::to_string(operation).unwrap()]).map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn history(&self) -> Result<Vec<OperationResult>, String> {
        let mut statement = self
            .connection
            .prepare("SELECT body FROM operations ORDER BY started_at DESC LIMIT 500")
            .map_err(|e| e.to_string())?;
        let values = statement
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        values
            .map(|v| {
                serde_json::from_str(&v.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
            })
            .collect()
    }
    pub fn mark_created(&self, key: &str) -> Result<(), String> {
        self.connection
            .execute(
                "INSERT OR IGNORE INTO created_routes(route_key,created_at) VALUES(?1,?2)",
                params![key, now()],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn created_keys(&self) -> Result<std::collections::HashSet<String>, String> {
        let mut stmt = self
            .connection
            .prepare("SELECT route_key FROM created_routes")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }
}
fn write_library(conn: &Connection, library: &Library) -> Result<(), String> {
    conn.execute_batch(
        "DELETE FROM group_members; DELETE FROM route_groups; DELETE FROM route_configs;",
    )
    .map_err(|e| e.to_string())?;
    for (position, route) in library.routes.iter().enumerate() {
        conn.execute(
            "INSERT INTO route_configs(id,body,position) VALUES(?1,?2,?3)",
            params![
                route.id,
                serde_json::to_string(route).unwrap(),
                position as i64
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    for (position, group) in library.groups.iter().enumerate() {
        conn.execute(
            "INSERT INTO route_groups(id,name,position) VALUES(?1,?2,?3)",
            params![group.id, group.name, position as i64],
        )
        .map_err(|e| e.to_string())?;
        for (member_position, id) in group.routes.iter().enumerate() {
            conn.execute(
                "INSERT INTO group_members(group_id,route_id,position) VALUES(?1,?2,?3)",
                params![group.id, id, member_position as i64],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
#[derive(Serialize)]
struct ExportDocument {
    version: u32,
    routes: Vec<RouteConfig>,
    groups: Vec<RouteGroup>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ImportDocument {
    #[serde(default)]
    version: Option<u32>,
    routes: Vec<ImportRoute>,
    groups: Vec<RouteGroup>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ImportRoute {
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    prefix: Option<String>,
    #[serde(default)]
    destination: Option<String>,
    #[serde(default)]
    mask: Option<String>,
    gateway: String,
    #[serde(default)]
    interface_guid: Option<String>,
    #[serde(default)]
    metric: Option<u16>,
    #[serde(default)]
    persistent: bool,
    #[serde(default)]
    comment: String,
}
pub fn parse_yaml(text: &str) -> Result<Library, String> {
    if text.len() > 4 * 1024 * 1024 {
        return Err("YAML 文件不能超过 4 MB".into());
    }
    let document: ImportDocument = serde_yaml::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|e| format!("YAML 格式错误：{e}"))?;
    if document.version.is_some_and(|v| v != 1 && v != 2) {
        return Err("不支持的 YAML 版本".into());
    }
    let mut routes = Vec::new();
    for route in document.routes {
        let prefix = match (&route.prefix, &route.destination, &route.mask) {
            (Some(prefix), None, None) => prefix.clone(),
            (None, Some(destination), Some(mask)) => {
                let mask: std::net::Ipv4Addr = mask.parse().map_err(|_| "子网掩码无效")?;
                let bits = u32::from(mask);
                let prefix_len = bits.leading_ones();
                let expected = if prefix_len == 0 {
                    0
                } else {
                    u32::MAX << (32 - prefix_len)
                };
                if bits != expected {
                    return Err("子网掩码必须连续".into());
                }
                format!("{destination}/{prefix_len}")
            }
            _ => return Err("必须指定 prefix，或同时指定 destination 和 mask".into()),
        };
        routes.push(RouteConfig {
            id: route.id.clone(),
            name: if route.name.is_empty() {
                route.id
            } else {
                route.name
            },
            prefix,
            gateway: route.gateway,
            interface_guid: route.interface_guid,
            metric: route.metric,
            persistent: route.persistent,
            comment: route.comment,
        });
    }
    let mut library = Library {
        routes,
        groups: document.groups,
    };
    validate_library(&mut library)?;
    Ok(library)
}
