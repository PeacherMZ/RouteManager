use crate::model::*;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr};

pub fn normalize_config(config: &mut RouteConfig) -> Result<(), String> {
    config.id = config.id.trim().to_string();
    config.name = config.name.trim().to_string();
    if config.id.is_empty() || config.name.is_empty() {
        return Err("路由 ID 和名称不能为空".into());
    }
    let network: ipnet::Ipv4Net = config
        .prefix
        .trim()
        .parse()
        .map_err(|_| "请输入有效 IPv4 网段，例如 203.0.113.0/24；IPv6 只读")?;
    config.prefix = network.trunc().to_string();
    let gateway: Ipv4Addr = config
        .gateway
        .trim()
        .parse()
        .map_err(|_| "请输入有效 IPv4 网关")?;
    config.gateway = gateway.to_string();
    config.interface_guid = match config.interface_guid.take() {
        Some(guid) if !guid.trim().is_empty() => Some(
            uuid::Uuid::parse_str(guid.trim().trim_matches(|c| c == '{' || c == '}'))
                .map_err(|_| "网卡 GUID 无效")?
                .to_string(),
        ),
        _ => None,
    };
    Ok(())
}
pub fn validate_library(library: &mut Library) -> Result<(), String> {
    let mut ids = HashMap::new();
    let mut identities = HashSet::new();
    for route in &mut library.routes {
        normalize_config(route)?;
        if ids
            .insert(route.id.to_lowercase(), route.id.clone())
            .is_some()
        {
            return Err(format!("路由 ID 重复：{}", route.id));
        }
        if !identities.insert(format!(
            "{}|{}|{:?}",
            route.prefix, route.gateway, route.interface_guid
        )) {
            return Err(format!("重复的路由配置：{}", route.name));
        }
    }
    let mut group_ids = HashSet::new();
    for group in &mut library.groups {
        group.id = group.id.trim().to_string();
        group.name = group.name.trim().to_string();
        if group.id.is_empty() || group.name.is_empty() {
            return Err("分组 ID 和名称不能为空".into());
        }
        if !group_ids.insert(group.id.to_lowercase()) {
            return Err(format!("分组 ID 重复：{}", group.id));
        }
        let mut members = HashSet::new();
        for id in &mut group.routes {
            *id = ids
                .get(&id.to_lowercase())
                .ok_or_else(|| format!("分组 {} 引用了不存在的路由 {id}", group.name))?
                .clone();
            if !members.insert(id.clone()) {
                return Err(format!("分组 {} 有重复成员 {id}", group.name));
            }
        }
    }
    Ok(())
}
pub fn normalize_snapshot(snapshot: &mut SystemSnapshot) -> Result<(), String> {
    for record in &mut snapshot.routes {
        record.associated_interface_guid = None;
        let net: ipnet::IpNet = record
            .prefix
            .parse()
            .map_err(|_| format!("系统返回无效前缀：{}", record.prefix))?;
        record.prefix = net.trunc().to_string();
        let ip: IpAddr = record.gateway.parse().map_err(|_| "系统返回无效网关")?;
        record.gateway = ip.to_string();
        record.interface_guid = record
            .interface_guid
            .trim_matches(|c| c == '{' || c == '}')
            .to_lowercase();
    }
    for interface in &mut snapshot.interfaces {
        interface.guid = interface
            .guid
            .trim_matches(|c| c == '{' || c == '}')
            .to_lowercase();
    }
    // Legacy route.exe -p records use ifIndex 0 and have no GUID. Associate only
    // when an active route identifies one interface; preserve the physical fields
    // so Windows mutations still address the real persistent record (ifIndex 0).
    let active = snapshot.routes.clone();
    for record in &mut snapshot.routes {
        if record.store == "PersistentStore"
            && record.interface_index == 0
            && record.interface_guid.is_empty()
        {
            let candidates: HashSet<_> = active
                .iter()
                .filter(|a| {
                    a.store == "ActiveStore"
                        && a.family == record.family
                        && a.prefix == record.prefix
                        && a.gateway == record.gateway
                })
                .map(|a| a.interface_guid.clone())
                .collect();
            if candidates.len() == 1 {
                let guid = candidates.into_iter().next().unwrap();
                if !guid.is_empty() {
                    record.associated_interface_guid = Some(guid);
                }
            }
        }
    }
    snapshot
        .routes
        .sort_by_key(|r| format!("{}|{}", r.key(), r.store));
    Ok(())
}
pub fn is_system(record: &RouteRecord) -> bool {
    matches!(
        record.protocol.to_lowercase().as_str(),
        "local" | "dhcp" | "icmp" | "routeradvertisement" | "2" | "4" | "19"
    )
}
pub fn build_snapshot(
    raw: &SystemSnapshot,
    library: &Library,
    created: &HashSet<String>,
) -> RouteSnapshot {
    let mut rows: BTreeMap<String, RouteView> = BTreeMap::new();
    for route in &raw.routes {
        let key = route.key();
        let row = rows.entry(key.clone()).or_insert_with(|| RouteView {
            key: key.clone(),
            records: Vec::new(),
            config_ids: Vec::new(),
            ambiguous_config_ids: Vec::new(),
            ownership: "other".into(),
            created_by_app: created.contains(&key),
        });
        row.records.push(route.clone());
    }
    let mut matches = Vec::new();
    for config in &library.routes {
        let mut candidates: Vec<String> = rows
            .iter()
            .filter(|(_, v)| {
                let r = &v.records[0];
                r.family == "IPv4"
                    && r.prefix == config.prefix
                    && r.gateway == config.gateway
                    && config
                        .interface_guid
                        .as_ref()
                        .is_none_or(|g| g.eq_ignore_ascii_case(r.logical_guid()))
            })
            .map(|(key, _)| key.clone())
            .collect();
        if !candidates.is_empty() {
            for (key, row) in &rows {
                if row.records.iter().any(|r| {
                    unassociated_persistent(r)
                        && r.family == "IPv4"
                        && r.prefix == config.prefix
                        && r.gateway == config.gateway
                }) && !candidates.contains(key)
                {
                    candidates.push(key.clone());
                }
            }
        }
        let ambiguous = candidates.len() > 1;
        let state = if ambiguous {
            "ambiguous"
        } else if candidates.is_empty() {
            "inactive"
        } else {
            let records = &rows[&candidates[0]].records;
            let active = records.iter().any(|r| r.store == "ActiveStore");
            let persistent = records.iter().any(|r| r.store == "PersistentStore");
            let metric_ok = config
                .metric
                .is_none_or(|m| records.iter().all(|r| r.route_metric == m));
            if !active && persistent {
                "persistent_only"
            } else if persistent != config.persistent || !metric_ok {
                "drifted"
            } else {
                "active"
            }
        };
        for key in &candidates {
            let row = rows.get_mut(key).unwrap();
            if ambiguous {
                row.ambiguous_config_ids.push(config.id.clone());
            } else {
                row.config_ids.push(config.id.clone());
            }
        }
        matches.push(RouteMatch {
            config_id: config.id.clone(),
            state: state.into(),
            route_keys: candidates,
            reason: match state {
                "ambiguous" => "多个接口或未绑定接口的持久记录命中，请先检查接口及持久记录",
                "inactive" => "当前系统中没有匹配路由",
                "persistent_only" => "仅存在持久记录，当前未生效",
                "drifted" => "metric 或持久属性与配置不一致",
                _ => "目标、网关、接口及配置属性一致",
            }
            .into(),
        });
    }
    for row in rows.values_mut() {
        row.ownership = if !row.config_ids.is_empty() {
            "managed"
        } else if row.records.iter().any(is_system) {
            "system"
        } else {
            "other"
        }
        .into();
    }
    RouteSnapshot {
        captured_at: now(),
        routes: rows.into_values().collect(),
        interfaces: raw.interfaces.clone(),
        matches,
    }
}
pub fn records_for(raw: &SystemSnapshot, key: &str) -> Vec<RouteRecord> {
    raw.routes
        .iter()
        .filter(|r| r.key() == key)
        .cloned()
        .collect()
}
pub fn target_records(raw: &SystemSnapshot, target: &RouteConfig) -> Vec<RouteRecord> {
    raw.routes
        .iter()
        .filter(|r| {
            r.family == "IPv4"
                && r.prefix == target.prefix
                && r.gateway == target.gateway
                && target
                    .interface_guid
                    .as_ref()
                    .is_some_and(|g| g.eq_ignore_ascii_case(r.logical_guid()))
        })
        .cloned()
        .collect()
}
pub fn same_physical_record(a: &RouteRecord, b: &RouteRecord) -> bool {
    a.family == b.family
        && a.prefix == b.prefix
        && a.gateway == b.gateway
        && a.interface_index == b.interface_index
        && a.interface_guid == b.interface_guid
        && a.store == b.store
}
pub fn remaining_before(raw: &SystemSnapshot, before: &[RouteRecord]) -> Vec<RouteRecord> {
    raw.routes
        .iter()
        .filter(|r| before.iter().any(|b| same_physical_record(r, b)))
        .cloned()
        .collect()
}
pub fn unassociated_persistent(record: &RouteRecord) -> bool {
    record.store == "PersistentStore"
        && record.interface_index == 0
        && record.interface_guid.is_empty()
        && record.associated_interface_guid.is_none()
}
// Interface indexes, metrics, store membership and protocols matter; volatile lifetimes do not.
pub fn fingerprint(records: &[RouteRecord]) -> String {
    let mut values: Vec<String> = records
        .iter()
        .map(|r| serde_json::to_string(r).unwrap())
        .collect();
    values.sort();
    hash(values.join("\n").as_bytes())
}
pub fn target_satisfied(raw: &SystemSnapshot, target: &RouteConfig) -> bool {
    let records = target_records(raw, target);
    let active = records.iter().any(|r| r.store == "ActiveStore");
    let persistent = records.iter().any(|r| r.store == "PersistentStore");
    active
        && persistent == target.persistent
        && target
            .metric
            .is_none_or(|m| records.iter().all(|r| r.route_metric == m))
}
