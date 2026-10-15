use route_manager::{
    db::{parse_yaml, Database},
    identity,
    model::*,
    routes::*,
    storage::{explicit_directory, InstanceLock},
};

#[test]
fn interface_ids_are_platform_qualified_and_do_not_alias() {
    assert!(!identity::matches("macos:enA:-", "macos:ena:-"));
    assert_eq!(
        identity::normalize("{11111111-1111-4111-8111-111111111111}").unwrap(),
        "windows:11111111-1111-4111-8111-111111111111"
    );
    assert_eq!(
        identity::normalize("macos:en0:11111111-1111-4111-8111-111111111111").unwrap(),
        "macos:en0:11111111-1111-4111-8111-111111111111"
    );
    for value in [
        "macos:en0;bad:-",
        "macos:../en0:-",
        "macos:en0:invalid",
        "linux:eth0",
        "",
    ] {
        assert!(identity::normalize(value).is_err());
    }
}
#[test]
fn macos_refuses_metric_and_tunnel_persistence() {
    assert!(identity::validate_target("macos:utun0:-", None, false).is_ok());
    assert!(identity::validate_target("macos:utun0:-", None, true).is_err());
    assert!(identity::validate_target(
        "macos:en0:11111111-1111-4111-8111-111111111111",
        Some(1),
        true
    )
    .is_err());
}
fn mac_record(scope: &str, store: &str) -> RouteRecord {
    serde_json::from_value(serde_json::json!({
        "family":"IPv4", "prefix":"203.0.113.0/24", "gateway":"192.0.2.1", "interface_index":7,
        "interface_id":"macos:en0:11111111-1111-4111-8111-111111111111", "interface_alias":"示例网络",
        "route_metric":0, "interface_metric":0,"protocol":"Static","store":store,"native":{"scope":scope,"flags":0}
    })).unwrap()
}
#[test]
fn mac_scopes_are_distinct_and_persistent_residual_cannot_disappear() {
    let global = mac_record("unscoped", "ActiveStore");
    let scoped = mac_record("scoped", "ActiveStore");
    assert_ne!(global.key(), scoped.key());
    assert!(!same_physical_record(&global, &scoped));
    let original = mac_record("scoped", "PersistentStore");
    let residual = mac_record("unscoped", "PersistentStore");
    assert!(same_physical_record(&original, &residual));
    let raw = SystemSnapshot {
        routes: vec![residual],
        interfaces: vec![],
    };
    assert_eq!(remaining_before(&raw, &[original]).len(), 1);
}
#[test]
fn scoped_and_unscoped_matches_are_ambiguous() {
    let raw = SystemSnapshot {
        routes: vec![
            mac_record("scoped", "ActiveStore"),
            mac_record("unscoped", "ActiveStore"),
        ],
        interfaces: vec![],
    };
    let config = RouteConfig {
        id: "a".into(),
        name: "example".into(),
        prefix: "203.0.113.0/24".into(),
        gateway: "192.0.2.1".into(),
        interface_id: Some(raw.routes[0].interface_id.clone()),
        metric: None,
        persistent: false,
        scope: None,
        comment: String::new(),
    };
    let result = build_snapshot(
        &raw,
        &Library {
            routes: vec![config],
            groups: vec![],
        },
        &Default::default(),
    );
    assert_eq!(result.matches[0].state, "ambiguous");
    assert!(result.routes.iter().all(|r| r.ownership != "managed"));
}
#[test]
fn data_override_requires_one_absolute_path() {
    assert!(explicit_directory(&["app".into(), "--data-dir".into(), "relative".into()]).is_err());
    assert!(explicit_directory(&["app".into(), "--data-dir".into()]).is_err());
    assert!(explicit_directory(&["app".into()]).unwrap().is_none());
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("中文 空格");
    assert_eq!(
        explicit_directory(&[
            "app".into(),
            "--data-dir".into(),
            path.clone().into_os_string()
        ])
        .unwrap(),
        Some(path)
    );
}

#[test]
fn explicit_mac_scope_matches_only_the_selected_physical_route() {
    let scoped = mac_record("scoped", "ActiveStore");
    let global = mac_record("unscoped", "ActiveStore");
    let raw = SystemSnapshot {
        routes: vec![scoped.clone(), global.clone()],
        interfaces: vec![],
    };
    let mut config: RouteConfig=serde_json::from_value(serde_json::json!({"id":"a","name":"example","prefix":scoped.prefix,"gateway":scoped.gateway,"interface_id":scoped.interface_id,"persistent":false,"scope":"scoped"})).unwrap();
    normalize_config(&mut config).unwrap();
    assert_eq!(target_records(&raw, &config), vec![scoped]);
    let snapshot = build_snapshot(
        &raw,
        &Library {
            routes: vec![config],
            groups: vec![],
        },
        &Default::default(),
    );
    assert_eq!(snapshot.matches[0].state, "active");
    assert_eq!(
        snapshot
            .routes
            .iter()
            .filter(|r| r.ownership == "managed")
            .count(),
        1
    );
    assert_eq!(
        snapshot
            .routes
            .iter()
            .find(|r| r.key == global.key())
            .unwrap()
            .ownership,
        "other"
    );
}
#[test]
fn instance_lock_is_per_directory_and_released() {
    let temp = tempfile::tempdir().unwrap();
    let first = InstanceLock::acquire(temp.path()).unwrap();
    assert!(InstanceLock::acquire(temp.path()).is_err());
    let separate = tempfile::tempdir().unwrap();
    let _other = InstanceLock::acquire(separate.path()).unwrap();
    drop(first);
    assert!(InstanceLock::acquire(temp.path()).is_ok());
}
#[test]
fn reopen_preserves_settings_and_does_not_import_adjacent_legacy() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("用户 数据");
    std::fs::create_dir_all(temp.path().join("legacy")).unwrap();
    std::fs::write(
        temp.path().join("legacy/routes.yaml"),
        "invalid private placeholder",
    )
    .unwrap();
    {
        let db = Database::open(&path, None).unwrap();
        db.set_setting("theme", &serde_json::json!("dark")).unwrap();
    }
    let db = Database::open(&path, None).unwrap();
    assert_eq!(
        db.get_setting("theme").unwrap(),
        Some(serde_json::json!("dark"))
    );
    assert!(db.library().unwrap().routes.is_empty());
}
#[test]
fn schema_upgrade_preserves_config_and_setting_with_backup() {
    let temp = tempfile::tempdir().unwrap();
    {
        let db = Database::open(temp.path(), None).unwrap();
        db.set_setting("theme", &serde_json::json!("dark")).unwrap();
        db.connection.execute("INSERT INTO route_configs(id,body,position) VALUES('a',?1,0)",[r#"{"id":"a","name":"example","prefix":"203.0.113.0/24","gateway":"192.0.2.1","interface_guid":"11111111-1111-4111-8111-111111111111","metric":10,"persistent":true,"comment":""}"#]).unwrap();
        db.connection
            .execute_batch("PRAGMA user_version=1")
            .unwrap();
    }
    let db = Database::open(temp.path(), None).unwrap();
    assert!(db.library().unwrap().routes[0]
        .interface_id
        .as_ref()
        .unwrap()
        .starts_with("windows:"));
    assert_eq!(
        db.get_setting("theme").unwrap(),
        Some(serde_json::json!("dark"))
    );
    assert!(std::fs::read_dir(temp.path().join("backups"))
        .unwrap()
        .any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("before-v2")));
}
#[test]
fn future_schema_is_not_reset() {
    let temp = tempfile::tempdir().unwrap();
    {
        let db = Database::open(temp.path(), None).unwrap();
        db.connection
            .execute_batch("PRAGMA user_version=999")
            .unwrap();
    }
    assert!(Database::open(temp.path(), None).is_err());
    let conn = rusqlite::Connection::open(temp.path().join("routes.db")).unwrap();
    assert_eq!(
        conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i32>(0))
            .unwrap(),
        999
    );
}
#[test]
fn v3_yaml_roundtrip_and_legacy_guid_import() {
    let input="version: 2\nroutes:\n  - id: a\n    name: example\n    prefix: 203.0.113.0/24\n    gateway: 192.0.2.1\n    interface_guid: 11111111-1111-4111-8111-111111111111\ngroups: []\n";
    let library = parse_yaml(input).unwrap();
    assert!(library.routes[0]
        .interface_id
        .as_ref()
        .unwrap()
        .starts_with("windows:"));
    let temp = tempfile::tempdir().unwrap();
    let mut db = Database::open(temp.path(), None).unwrap();
    db.save_library(library.clone()).unwrap();
    let output = std::fs::read_to_string(db.export().unwrap()).unwrap();
    assert!(output.starts_with("version: 3"));
    assert_eq!(parse_yaml(&output).unwrap(), library);
}
