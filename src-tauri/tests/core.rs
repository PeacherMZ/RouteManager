use route_manager::{
    db::{parse_yaml, Database},
    hosts,
    model::*,
    routes::*,
    service::AppService,
    system::RouteSystem,
};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
};
const GUID: &str = "11111111-1111-4111-8111-111111111111";
const GUID2: &str = "22222222-2222-4222-8222-222222222222";
fn config() -> RouteConfig {
    RouteConfig {
        id: "route-a".into(),
        name: "测试路由".into(),
        prefix: "203.0.113.0/24".into(),
        gateway: "192.0.2.1".into(),
        interface_guid: Some(GUID.into()),
        metric: Some(10),
        persistent: true,
        comment: "备注".into(),
    }
}
fn interface(guid: &str, index: u32) -> NetworkInterface {
    NetworkInterface {
        guid: guid.into(),
        index,
        alias: format!("网卡{index}"),
        status: "Up".into(),
        addresses: vec!["192.0.2.2/24".into()],
    }
}
fn record(config: &RouteConfig, store: &str) -> RouteRecord {
    let guid = config.interface_guid.clone().unwrap_or(GUID.into());
    let index = if guid == GUID { 7 } else { 8 };
    RouteRecord {
        family: "IPv4".into(),
        prefix: config.prefix.clone(),
        gateway: config.gateway.clone(),
        interface_guid: guid,
        associated_interface_guid: None,
        interface_index: index,
        interface_alias: format!("网卡{index}"),
        route_metric: config.metric.unwrap_or(256),
        interface_metric: 25,
        protocol: "NetMgmt".into(),
        rollback_safe: true,
        store: store.into(),
    }
}
fn raw_with(config: &RouteConfig) -> SystemSnapshot {
    SystemSnapshot {
        routes: vec![
            record(config, "ActiveStore"),
            record(config, "PersistentStore"),
        ],
        interfaces: vec![interface(GUID, 7), interface(GUID2, 8)],
    }
}
#[derive(Default)]
struct FakeState {
    raw: SystemSnapshot,
    writes: usize,
    reads: usize,
    fail_prefix: Option<String>,
    fail_reads: bool,
    leave_persistent: bool,
}
struct Fake(Arc<Mutex<FakeState>>);
impl RouteSystem for Fake {
    fn snapshot(&mut self) -> Result<SystemSnapshot, String> {
        let mut s = self.0.lock().unwrap();
        s.reads += 1;
        if s.fail_reads {
            Err("读取失败".into())
        } else {
            let mut raw = s.raw.clone();
            normalize_snapshot(&mut raw)?;
            Ok(raw)
        }
    }
    fn remove(&mut self, records: &[RouteRecord]) -> Result<(), String> {
        let mut s = self.0.lock().unwrap();
        s.writes += 1;
        let leave_persistent = s.leave_persistent;
        s.raw.routes.retain(|r| {
            (leave_persistent && r.store == "PersistentStore")
                || !records.iter().any(|b| same_physical_record(r, b))
        });
        Ok(())
    }
    fn add(&mut self, target: &RouteConfig) -> Result<(), String> {
        let mut s = self.0.lock().unwrap();
        s.writes += 1;
        if s.fail_prefix.as_ref() == Some(&target.prefix) {
            return Err("模拟添加失败".into());
        }
        s.raw.routes.push(record(target, "ActiveStore"));
        if target.persistent {
            s.raw.routes.push(record(target, "PersistentStore"));
        }
        Ok(())
    }
    fn metric(&mut self, records: &[RouteRecord], metric: u16) -> Result<(), String> {
        let mut s = self.0.lock().unwrap();
        s.writes += 1;
        for r in &mut s.raw.routes {
            if records.iter().any(|b| same_physical_record(r, b)) {
                r.route_metric = metric;
            }
        }
        Ok(())
    }
}
fn service(
    raw: SystemSnapshot,
    library: Library,
) -> (tempfile::TempDir, AppService, Arc<Mutex<FakeState>>) {
    let directory = tempfile::tempdir().unwrap();
    let mut db = Database::open(directory.path(), None).unwrap();
    db.save_library(library).unwrap();
    let state = Arc::new(Mutex::new(FakeState {
        raw,
        ..Default::default()
    }));
    let app = AppService {
        db,
        system: Box::new(Fake(state.clone())),
        pending: None,
    };
    (directory, app, state)
}
fn library(config: RouteConfig) -> Library {
    Library {
        routes: vec![config],
        groups: vec![],
    }
}
fn request(action: &str) -> PlanRequest {
    PlanRequest {
        action: action.into(),
        config_ids: vec![],
        route_keys: vec![],
        draft: None,
        source_key: None,
        save_config: false,
    }
}
#[test]
fn legacy_migration_preserves_routes_and_group_order_and_is_idempotent() {
    let directory = tempfile::tempdir().unwrap();
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/legacy-example.yaml");
    let mut db = Database::open(directory.path(), Some(&source)).unwrap();
    let lib = db.library().unwrap();
    assert_eq!(lib.routes.len(), 3);
    assert_eq!(lib.groups.len(), 2);
    assert_eq!(lib.routes[0].prefix, "203.0.113.0/24");
    assert_eq!(lib.routes[0].gateway, "192.0.2.1");
    assert_eq!(lib.routes[0].interface_guid, None);
    assert_eq!(lib.groups[0].routes[0], "example-network");
    assert_eq!(
        lib.groups[1].routes,
        vec!["example-host-b", "example-host-a"]
    );
    db.save_library(Library::default()).unwrap();
    drop(db);
    let db = Database::open(directory.path(), Some(&source)).unwrap();
    assert!(db.library().unwrap().routes.is_empty());
}
#[test]
fn yaml_roundtrip_keeps_extended_fields() {
    let directory = tempfile::tempdir().unwrap();
    let mut db = Database::open(directory.path(), None).unwrap();
    let mut lib = library(config());
    lib.groups.push(RouteGroup {
        id: "g".into(),
        name: "分组".into(),
        routes: vec!["route-a".into()],
    });
    db.save_library(lib.clone()).unwrap();
    let exported = std::fs::read_to_string(db.export().unwrap()).unwrap();
    assert_eq!(parse_yaml(&exported).unwrap(), lib);
}
#[test]
fn invalid_import_is_atomic() {
    let directory = tempfile::tempdir().unwrap();
    let mut db = Database::open(directory.path(), None).unwrap();
    let lib = library(config());
    db.save_library(lib.clone()).unwrap();
    assert!(db
        .import("routes: []\ngroups:\n  - id: g\n    name: 组\n    routes: [missing]")
        .is_err());
    assert_eq!(db.library().unwrap(), lib);
}
#[test]
fn noncontiguous_mask_is_rejected() {
    assert!(parse_yaml("routes:\n- id: a\n  destination: 1.2.3.0\n  mask: 255.0.255.0\n  gateway: 1.2.3.1\ngroups: []").is_err());
}
#[test]
fn normalization_and_ipv6_guard() {
    let mut c = config();
    c.prefix = "203.0.113.123/24".into();
    normalize_config(&mut c).unwrap();
    assert_eq!(c.prefix, "203.0.113.0/24");
    c.prefix = "2001:db8::/64".into();
    assert!(normalize_config(&mut c).is_err());
}
#[test]
fn duplicate_ids_case_insensitive_and_missing_members_rejected() {
    let mut lib = library(config());
    let mut second = config();
    second.id = "ROUTE-A".into();
    second.gateway = "192.0.2.9".into();
    lib.routes.push(second);
    assert!(validate_library(&mut lib).is_err());
    let mut lib = library(config());
    lib.groups.push(RouteGroup {
        id: "g".into(),
        name: "组".into(),
        routes: vec!["missing".into()],
    });
    assert!(validate_library(&mut lib).is_err());
}
#[test]
fn exact_match_separates_other_gateway() {
    let c = config();
    let mut raw = raw_with(&c);
    let mut other = record(&c, "ActiveStore");
    other.gateway = "192.0.2.9".into();
    raw.routes.push(other);
    let snapshot = build_snapshot(&raw, &library(c), &HashSet::new());
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
            .filter(|r| r.ownership == "other")
            .count(),
        1
    );
}
#[test]
fn legacy_multi_interface_match_is_ambiguous() {
    let mut c = config();
    c.interface_guid = None;
    let mut raw = raw_with(&c);
    let mut second = c.clone();
    second.interface_guid = Some(GUID2.into());
    raw.routes.push(record(&second, "ActiveStore"));
    let snapshot = build_snapshot(&raw, &library(c), &HashSet::new());
    assert_eq!(snapshot.matches[0].state, "ambiguous");
    assert!(snapshot.routes.iter().all(|r| r.ownership != "managed"));
}
#[test]
fn guid_binding_survives_interface_index_change_in_matching() {
    let c = config();
    let mut raw = raw_with(&c);
    for r in &mut raw.routes {
        r.interface_index = 99;
    }
    let snapshot = build_snapshot(&raw, &library(c), &HashSet::new());
    assert_eq!(snapshot.matches[0].state, "active");
}
#[test]
fn metric_drift_and_persistent_only_are_visible() {
    let c = config();
    let mut raw = raw_with(&c);
    raw.routes[0].route_metric = 200;
    assert_eq!(
        build_snapshot(&raw, &library(c.clone()), &HashSet::new()).matches[0].state,
        "drifted"
    );
    raw.routes.retain(|r| r.store == "PersistentStore");
    assert_eq!(
        build_snapshot(&raw, &library(c), &HashSet::new()).matches[0].state,
        "persistent_only"
    );
}
#[test]
fn system_protocol_is_not_confused_with_unknown_static() {
    let c = config();
    let mut raw = raw_with(&c);
    raw.routes[0].protocol = "Dhcp".into();
    assert_eq!(
        build_snapshot(&raw, &Library::default(), &HashSet::new()).routes[0].ownership,
        "system"
    );
    raw.routes[0].protocol = "NetMgmt".into();
    assert_eq!(
        build_snapshot(&raw, &Library::default(), &HashSet::new()).routes[0].ownership,
        "other"
    );
}
#[test]
fn apply_identical_is_idempotent_and_writes_nothing() {
    let c = config();
    let (_dir, mut app, state) = service(raw_with(&c), library(c));
    let mut req = request("apply");
    req.config_ids = vec!["route-a".into()];
    let plan = app.plan(req).unwrap();
    assert_eq!(plan.items[0].action, "skip");
    let result = app.execute(&plan.id).unwrap();
    assert_eq!(result.items[0].status, "skipped");
    assert_eq!(
        state.lock().unwrap().reads,
        2,
        "one preview + one fresh execution read"
    );
    assert_eq!(state.lock().unwrap().writes, 0);
}
#[test]
fn unset_metric_does_not_rewrite_different_store_metrics() {
    let mut c = config();
    c.metric = None;
    let mut raw = raw_with(&c);
    raw.routes[0].route_metric = 10;
    raw.routes[1].route_metric = 20;
    let (_dir, mut app, state) = service(raw, library(c));
    let mut req = request("apply");
    req.config_ids = vec!["route-a".into()];
    let plan = app.plan(req).unwrap();
    assert_eq!(plan.items[0].action, "skip");
    app.execute(&plan.id).unwrap();
    assert_eq!(state.lock().unwrap().writes, 0);
}
#[test]
fn clear_managed_removes_both_stores_but_preserves_library_and_other_routes() {
    let c = config();
    let mut raw = raw_with(&c);
    let mut other = config();
    other.prefix = "198.51.100.0/24".into();
    raw.routes.push(record(&other, "ActiveStore"));
    let (_dir, mut app, state) = service(raw, library(c));
    let plan = app.plan(request("clear_managed")).unwrap();
    let result = app.execute(&plan.id).unwrap();
    assert_eq!(result.status, "success");
    assert_eq!(app.db.library().unwrap().routes.len(), 1);
    let remaining = &state.lock().unwrap().raw.routes;
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].prefix, other.prefix);
}
#[test]
fn stale_route_blocks_before_any_mutation() {
    let c = config();
    let (_dir, mut app, state) = service(raw_with(&c), library(c));
    let plan = app.plan(request("clear_managed")).unwrap();
    state.lock().unwrap().raw.routes[0].route_metric = 200;
    assert!(app.execute(&plan.id).is_err());
    assert_eq!(state.lock().unwrap().writes, 0);
}
#[test]
fn stale_library_blocks_before_any_mutation() {
    let c = config();
    let (_dir, mut app, state) = service(raw_with(&c), library(c));
    let plan = app.plan(request("clear_managed")).unwrap();
    app.db.save_library(Library::default()).unwrap();
    assert!(app.execute(&plan.id).is_err());
    assert_eq!(state.lock().unwrap().writes, 0);
}
#[test]
fn ipv6_remove_is_rejected_in_backend() {
    let mut raw = raw_with(&config());
    raw.routes[0].family = "IPv6".into();
    raw.routes[0].prefix = "::/0".into();
    raw.routes[0].gateway = "fe80::1".into();
    let mut req = request("remove");
    req.route_keys = vec![raw.routes[0].key()];
    let (_dir, mut app, state) = service(raw, Library::default());
    assert!(app.plan(req).is_err());
    assert_eq!(state.lock().unwrap().writes, 0);
}
#[test]
fn failed_replacement_restores_old_static_and_does_not_update_config() {
    let c = config();
    let raw = raw_with(&c);
    let source = raw.routes[0].key();
    let (_dir, mut app, state) = service(raw, library(c.clone()));
    let mut changed = c.clone();
    changed.prefix = "198.51.100.0/24".into();
    state.lock().unwrap().fail_prefix = Some(changed.prefix.clone());
    let mut req = request("upsert");
    req.draft = Some(changed);
    req.source_key = Some(source);
    req.save_config = true;
    let plan = app.plan(req).unwrap();
    let result = app.execute(&plan.id).unwrap();
    assert_eq!(result.status, "failed");
    assert_eq!(
        result.items[0].recovery.as_deref(),
        Some("原静态路由已恢复并核验")
    );
    assert_eq!(app.db.library().unwrap().routes[0], c);
    assert_eq!(state.lock().unwrap().raw.routes.len(), 2);
}
#[test]
fn batch_partial_failure_is_reported_and_order_is_preserved() {
    let a = config();
    let mut b = config();
    b.id = "000-first".into();
    b.prefix = "198.51.100.0/24".into();
    let raw = SystemSnapshot {
        routes: vec![],
        interfaces: vec![interface(GUID, 7)],
    };
    let (_dir, mut app, state) = service(
        raw,
        Library {
            routes: vec![a.clone(), b.clone()],
            groups: vec![],
        },
    );
    state.lock().unwrap().fail_prefix = Some(b.prefix);
    let mut req = request("apply");
    req.config_ids = vec![a.id, b.id];
    let plan = app.plan(req).unwrap();
    assert_eq!(plan.items[0].target.as_ref().unwrap().id, "route-a");
    let result = app.execute(&plan.id).unwrap();
    assert_eq!(result.status, "partial");
    assert_eq!(result.items[0].status, "success");
    assert_eq!(result.items[1].status, "failed");
}
#[test]
fn missing_or_disconnected_interface_blocks_apply() {
    let c = config();
    let mut raw = raw_with(&c);
    raw.interfaces[0].status = "Disconnected".into();
    let (_dir, mut app, state) = service(raw, library(c));
    let mut req = request("apply");
    req.config_ids = vec!["route-a".into()];
    assert!(app.plan(req).is_err());
    assert_eq!(state.lock().unwrap().writes, 0);
}
#[test]
fn read_failure_never_produces_success() {
    let c = config();
    let (_dir, mut app, state) = service(raw_with(&c), library(c));
    state.lock().unwrap().fail_reads = true;
    assert!(app.snapshot().is_err());
    assert!(app.plan(request("clear_managed")).is_err());
}
#[test]
fn new_route_requires_unique_interface_and_logs_creation() {
    let mut c = config();
    c.interface_guid = None;
    let (_dir, mut app, state) = service(
        SystemSnapshot {
            routes: vec![],
            interfaces: vec![interface(GUID, 7)],
        },
        library(c),
    );
    let mut req = request("apply");
    req.config_ids = vec!["route-a".into()];
    let plan = app.plan(req).unwrap();
    app.execute(&plan.id).unwrap();
    assert_eq!(state.lock().unwrap().raw.routes.len(), 2);
    assert!(app.snapshot().unwrap().routes[0].created_by_app);
}
#[test]
fn hosts_preserves_bom_and_crlf_and_backs_up() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::create_dir(directory.path().join("backups")).unwrap();
    let path = directory.path().join("hosts");
    let original = [vec![0xef, 0xbb, 0xbf], b"# original\r\n".to_vec()].concat();
    std::fs::write(&path, &original).unwrap();
    let document = hosts::read(&path).unwrap();
    let next = hosts::save(
        &path,
        directory.path(),
        "# changed\n127.0.0.1 localhost\n",
        &document.fingerprint,
    )
    .unwrap();
    assert_eq!(next.encoding, "UTF-8 BOM");
    assert_eq!(next.newline, "CRLF");
    assert!(std::fs::read(&path)
        .unwrap()
        .starts_with(&[0xef, 0xbb, 0xbf]));
    let backup = std::fs::read_dir(directory.path().join("backups"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert_eq!(std::fs::read(backup).unwrap(), original);
}
#[test]
fn hosts_detects_external_changes_without_overwrite() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::create_dir(directory.path().join("backups")).unwrap();
    let path = directory.path().join("hosts");
    std::fs::write(&path, "old").unwrap();
    let document = hosts::read(&path).unwrap();
    std::fs::write(&path, "external").unwrap();
    assert!(hosts::save(&path, directory.path(), "new", &document.fingerprint).is_err());
    assert_eq!(std::fs::read_to_string(path).unwrap(), "external");
}
#[test]
fn hosts_preserves_utf16() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::create_dir(directory.path().join("backups")).unwrap();
    let path = directory.path().join("hosts");
    let mut bytes = vec![0xff, 0xfe];
    for unit in "# 原始\r\n".encode_utf16() {
        bytes.extend(unit.to_le_bytes());
    }
    std::fs::write(&path, bytes).unwrap();
    let document = hosts::read(&path).unwrap();
    let saved = hosts::save(&path, directory.path(), "# 修改\n", &document.fingerprint).unwrap();
    assert_eq!(saved.encoding, "UTF-16 LE");
    assert_eq!(saved.content, "# 修改\r\n");
}
fn legacy_persistent(raw: &mut SystemSnapshot) {
    let persistent = raw
        .routes
        .iter_mut()
        .find(|r| r.store == "PersistentStore")
        .unwrap();
    persistent.interface_index = 0;
    persistent.interface_guid.clear();
    persistent.interface_alias = "iftype0_0".into();
    persistent.protocol.clear();
    persistent.rollback_safe = false;
}
#[test]
fn legacy_unbound_persistent_associates_only_with_unique_active_interface() {
    let mut c = config();
    c.interface_guid = None;
    c.metric = None;
    let mut raw = raw_with(&c);
    legacy_persistent(&mut raw);
    raw.routes[1].route_metric = 1;
    normalize_snapshot(&mut raw).unwrap();
    let snapshot = build_snapshot(&raw, &library(c), &HashSet::new());
    assert_eq!(snapshot.routes.len(), 1);
    assert_eq!(snapshot.matches[0].state, "active");
    let persistent = snapshot.routes[0]
        .records
        .iter()
        .find(|r| r.store == "PersistentStore")
        .unwrap();
    assert_eq!(persistent.interface_index, 0);
    assert_eq!(persistent.interface_guid, "");
    assert_eq!(persistent.associated_interface_guid.as_deref(), Some(GUID));
}
#[test]
fn legacy_unbound_persistent_clear_removes_real_ifindex_zero_record() {
    let mut c = config();
    c.interface_guid = None;
    let mut raw = raw_with(&c);
    legacy_persistent(&mut raw);
    let (_dir, mut app, state) = service(raw, library(c));
    let plan = app.plan(request("clear_managed")).unwrap();
    assert_eq!(plan.items.len(), 1);
    assert_eq!(plan.items[0].before.len(), 2);
    let result = app.execute(&plan.id).unwrap();
    assert_eq!(result.status, "success");
    assert!(state.lock().unwrap().raw.routes.is_empty());
}
#[test]
fn persistent_left_after_active_delete_is_failed_even_when_association_disappears() {
    let mut c = config();
    c.interface_guid = None;
    let mut raw = raw_with(&c);
    legacy_persistent(&mut raw);
    let (_dir, mut app, state) = service(raw, library(c));
    let plan = app.plan(request("clear_managed")).unwrap();
    state.lock().unwrap().leave_persistent = true;
    let result = app.execute(&plan.id).unwrap();
    assert_eq!(result.status, "failed");
    assert_eq!(result.items[0].after.len(), 1);
    assert_eq!(result.items[0].after[0].interface_index, 0);
}
#[test]
fn shared_unbound_persistent_is_not_claimed_even_with_a_bound_config() {
    let c = config();
    let mut raw = raw_with(&c);
    legacy_persistent(&mut raw);
    let mut second = c.clone();
    second.interface_guid = Some(GUID2.into());
    raw.routes.push(record(&second, "ActiveStore"));
    let selected = raw.routes[0].key();
    let (_dir, mut app, state) = service(raw, library(c));
    assert_eq!(app.snapshot().unwrap().matches[0].state, "ambiguous");
    assert!(app.plan(request("clear_managed")).is_err());
    let mut req = request("remove");
    req.route_keys = vec![selected];
    assert!(app.plan(req).is_err());
    assert_eq!(state.lock().unwrap().writes, 0);
}
#[test]
fn special_static_attributes_are_not_silently_recreated() {
    let c = config();
    let mut raw = raw_with(&c);
    for r in &mut raw.routes {
        r.rollback_safe = false;
    }
    let source = raw.routes[0].key();
    let (_dir, mut app, state) = service(raw, library(c.clone()));
    let mut changed = c;
    changed.prefix = "198.51.100.0/24".into();
    state.lock().unwrap().fail_prefix = Some(changed.prefix.clone());
    let mut req = request("upsert");
    req.draft = Some(changed);
    req.source_key = Some(source);
    let plan = app.plan(req).unwrap();
    let result = app.execute(&plan.id).unwrap();
    assert_eq!(result.status, "failed");
    assert!(result.items[0]
        .recovery
        .as_ref()
        .unwrap()
        .starts_with("未自动恢复"));
}
