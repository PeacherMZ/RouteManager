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
    config.interface_id = match config.interface_id.take() {
        Some(guid) if !guid.trim().is_empty() => Some(crate::identity::normalize(&guid)?),
        _ => None,
    };
    if config
        .scope
        .as_deref()
        .is_some_and(|s| !matches!(s, "scoped" | "unscoped"))
    {
        return Err("路由作用域无效".into());
    }
    if config.scope.is_some()
        && (config.persistent
            || config
                .interface_id
                .as_deref()
                .is_some_and(|id| !crate::identity::is_macos(id)))
    {
        return Err("作用域只适用于 macOS 临时路由；持久路由由网络服务决定作用域".into());
    }
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
            "{}|{}|{:?}|{:?}",
            route.prefix, route.gateway, route.interface_id, route.scope
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
        record.service_group = false;
        record.associated_interface_id = None;
        let net: ipnet::IpNet = record
            .prefix
            .parse()
            .map_err(|_| format!("系统返回无效前缀：{}", record.prefix))?;
        record.prefix = net.trunc().to_string();
        let ip: IpAddr = record.gateway.parse().map_err(|_| "系统返回无效网关")?;
        record.gateway = ip.to_string();
        if !record.interface_id.is_empty() {
            record.interface_id = crate::identity::normalize(&record.interface_id)?;
        }
    }
    for interface in &mut snapshot.interfaces {
        if !interface.guid.is_empty() {
            interface.guid = crate::identity::normalize(&interface.guid)?;
        }
    }
    // A single native service setting can yield both global and scoped active
    // routes. Group their presentation, but retain every physical scope/flag for
    // the preview, mutation, and residual checks. This does not assert provenance.
    let identity = |r: &RouteRecord| {
        (
            r.family.clone(),
            r.prefix.clone(),
            r.gateway.clone(),
            r.interface_id.clone(),
        )
    };
    let mut persistent_services = HashMap::new();
    for record in &snapshot.routes {
        if record.native.is_some()
            && record.store == "PersistentStore"
            && crate::identity::is_macos(&record.interface_id)
            && !record.interface_id.ends_with(":-")
        {
            *persistent_services
                .entry(identity(record))
                .or_insert(0usize) += 1;
        }
    }
    for record in &mut snapshot.routes {
        record.service_group =
            record.native.is_some() && persistent_services.get(&identity(record)) == Some(&1);
    }
    // Legacy route.exe -p records use ifIndex 0 and have no GUID. Associate only
    // when an active route identifies one interface; preserve the physical fields
    // so Windows mutations still address the real persistent record (ifIndex 0).
    let active = snapshot.routes.clone();
    for record in &mut snapshot.routes {
        if record.store == "PersistentStore"
            && record.interface_index == 0
            && record.interface_id.is_empty()
        {
            let candidates: HashSet<_> = active
                .iter()
                .filter(|a| {
                    a.store == "ActiveStore"
                        && a.family == record.family
                        && a.prefix == record.prefix
                        && a.gateway == record.gateway
                })
                .map(|a| a.interface_id.clone())
                .collect();
            if candidates.len() == 1 {
                let guid = candidates.into_iter().next().unwrap();
                if !guid.is_empty() {
                    record.associated_interface_id = Some(guid);
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
        "local" | "kernel" | "dhcp" | "icmp" | "routeradvertisement" | "2" | "4" | "19"
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
                        .interface_id
                        .as_ref()
                        .is_none_or(|g| crate::identity::matches(g, r.logical_guid()))
                    && config.scope.as_deref().is_none_or(|scope| {
                        v.records.iter().any(|r| {
                            r.store == "PersistentStore"
                                || r.native.as_ref().is_some_and(|n| n.scope == scope)
                        })
                    })
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
        let ambiguous = candidates.len() > 1
            || candidates.iter().any(|key| {
                let records = &rows[key].records;
                (config.scope.is_some() && records.iter().any(|r| r.service_group))
                    || records
                        .iter()
                        .filter(|r| r.native.is_some() && r.store == "PersistentStore")
                        .count()
                        > 1
            });
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
                    .interface_id
                    .as_ref()
                    .is_some_and(|g| crate::identity::matches(g, r.logical_guid()))
                && target.scope.as_deref().is_none_or(|scope| {
                    r.store == "PersistentStore"
                        || r.native.as_ref().is_some_and(|n| n.scope == scope)
                })
        })
        .cloned()
        .collect()
}
pub fn same_physical_record(a: &RouteRecord, b: &RouteRecord) -> bool {
    a.family == b.family
        && a.prefix == b.prefix
        && a.gateway == b.gateway
        && a.interface_index == b.interface_index
        && a.interface_id == b.interface_id
        && a.store == b.store
        && (a.store == "PersistentStore"
            || a.native.as_ref().map(|n| &n.scope) == b.native.as_ref().map(|n| &n.scope))
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
        && record.interface_id.is_empty()
        && record.associated_interface_id.is_none()
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
