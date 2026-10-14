use crate::{db::Database, model::*, routes::*, system::RouteSystem};
use std::collections::HashSet;

pub struct AppService {
    pub db: Database,
    pub system: Box<dyn RouteSystem>,
    pub pending: Option<OperationPlan>,
}
impl AppService {
    pub fn snapshot(&mut self) -> Result<RouteSnapshot, String> {
        let raw = self.system.snapshot()?;
        Ok(build_snapshot(
            &raw,
            &self.db.library()?,
            &self.db.created_keys()?,
        ))
    }
    pub fn plan(&mut self, request: PlanRequest) -> Result<OperationPlan, String> {
        self.pending = None;
        let library = self.db.library()?;
        let raw = self.system.snapshot()?;
        let snapshot = build_snapshot(&raw, &library, &self.db.created_keys()?);
        let mut items = Vec::new();
        let mut warnings = Vec::new();
        match request.action.as_str() {
            "remove" | "clear_managed" => {
                let mut keys = if request.action == "clear_managed" {
                    let ambiguous_count = snapshot
                        .matches
                        .iter()
                        .filter(|m| m.state == "ambiguous")
                        .count();
                    if ambiguous_count > 0 {
                        warnings.push(format!(
                            "{ambiguous_count} 条配置存在接口歧义，不在本次清除范围内"
                        ));
                    }
                    snapshot
                        .routes
                        .iter()
                        .filter(|r| r.ownership == "managed")
                        .map(|r| r.key.clone())
                        .collect()
                } else {
                    request.route_keys.clone()
                };
                keys.sort();
                keys.dedup();
                for key in keys {
                    let row = snapshot
                        .routes
                        .iter()
                        .find(|r| r.key == key)
                        .ok_or("路由已不存在，请刷新")?;
                    if row.records.iter().any(|r| r.family != "IPv4") {
                        return Err("IPv6 仅支持查看".into());
                    }
                    items.push(PlanItem {
                        id: uuid::Uuid::new_v4().to_string(),
                        label: row.records[0].prefix.clone(),
                        action: "remove".into(),
                        before: row.records.clone(),
                        target: None,
                        save_config: false,
                        warnings: warnings_for(&row.records, None),
                    });
                }
            }
            "apply" => {
                let mut ids = request.config_ids;
                let mut seen = HashSet::new();
                ids.retain(|id| seen.insert(id.clone()));
                for id in ids {
                    let config = library
                        .routes
                        .iter()
                        .find(|c| c.id == id)
                        .ok_or("配置不存在，请刷新")?;
                    let matched = snapshot.matches.iter().find(|m| m.config_id == id).unwrap();
                    if matched.state == "ambiguous" {
                        return Err(format!(
                            "{}：多个接口命中，请先在配置中选择接口",
                            config.name
                        ));
                    }
                    let before = matched
                        .route_keys
                        .first()
                        .map(|key| records_for(&raw, key))
                        .unwrap_or_default();
                    items.push(make_upsert(&raw, config.clone(), before, false)?);
                }
            }
            "upsert" => {
                let draft = request.draft.ok_or("缺少路由内容")?;
                let before = if let Some(key) = &request.source_key {
                    let before = records_for(&raw, key);
                    if before.is_empty() {
                        return Err("待修改路由已不存在，请刷新".into());
                    }
                    if before.iter().any(|r| r.family != "IPv4") {
                        return Err("IPv6 仅支持查看".into());
                    }
                    before
                } else {
                    Vec::new()
                };
                if request.save_config {
                    let mut trial = library.clone();
                    if let Some(existing) = trial
                        .routes
                        .iter_mut()
                        .find(|c| c.id.eq_ignore_ascii_case(&draft.id))
                    {
                        *existing = draft.clone();
                    } else {
                        trial.routes.push(draft.clone());
                    }
                    validate_library(&mut trial)?;
                }
                items.push(make_upsert(&raw, draft, before, request.save_config)?);
            }
            _ => return Err("未知操作类型".into()),
        }
        if items.is_empty() {
            return Err("没有可操作的路由；接口待确认的配置需要先绑定接口".into());
        }
        let mut identities = HashSet::new();
        for item in &items {
            check_persistent_scope(item, &raw)?;
            let identity = if let Some(t) = &item.target {
                format!("{}|{}|{:?}", t.prefix, t.gateway, t.interface_guid)
            } else {
                item.before[0].key()
            };
            if !identities.insert(identity) {
                return Err("本次选择包含指向同一系统路由的重复配置，请分别处理".into());
            }
        }
        let plan = OperationPlan {
            id: uuid::Uuid::new_v4().to_string(),
            created_at: now(),
            items,
            warnings,
            library_fingerprint: hash(serde_json::to_string(&library).unwrap().as_bytes()),
        };
        self.pending = Some(plan.clone());
        Ok(plan)
    }
    pub fn execute(&mut self, plan_id: &str) -> Result<OperationResult, String> {
        let plan = self.pending.take().ok_or("预览已失效，请重新预览")?;
        if plan.id != plan_id {
            return Err("预览已被更新，请重新确认".into());
        }
        let created =
            chrono::DateTime::parse_from_rfc3339(&plan.created_at).map_err(|e| e.to_string())?;
        if (chrono::Utc::now() - created.with_timezone(&chrono::Utc)).num_minutes() >= 10 {
            return Err("预览超过 10 分钟，请刷新后重试".into());
        }
        let library = self.db.library()?;
        if hash(serde_json::to_string(&library).unwrap().as_bytes()) != plan.library_fingerprint {
            return Err("配置库已变化，请重新预览".into());
        }
        let raw = self.system.snapshot()?;
        for item in &plan.items {
            check_preconditions(item, &raw)?;
        }
        let mut result = OperationResult {
            id: plan.id,
            started_at: now(),
            finished_at: String::new(),
            status: "running".into(),
            items: Vec::new(),
        };
        // Journal intended operations before touching the OS, including recoverable before images.
        for item in &plan.items {
            result.items.push(OperationItemResult {
                item_id: item.id.clone(),
                label: item.label.clone(),
                action: item.action.clone(),
                status: "pending".into(),
                message: "等待执行".into(),
                before: item.before.clone(),
                after: Vec::new(),
                recovery: None,
            });
        }
        self.db.record(&result)?;
        let read_only = plan.items.iter().all(|item| item.action == "skip");
        for (index, item) in plan.items.iter().enumerate() {
            result.items[index].status = "running".into();
            self.db.record(&result)?;
            let item_result = self.execute_item(item, read_only.then_some(&raw));
            result.items[index] = item_result;
            // If durable logging fails, stop before any further system mutation.
            self.db.record(&result)?;
        }
        let successes = result
            .items
            .iter()
            .filter(|r| r.status == "success" || r.status == "skipped")
            .count();
        result.status = if successes == result.items.len() {
            "success"
        } else if successes == 0 {
            "failed"
        } else {
            "partial"
        }
        .into();
        result.finished_at = now();
        self.db.record(&result)?;
        Ok(result)
    }
    fn execute_item(
        &mut self,
        item: &PlanItem,
        prechecked: Option<&SystemSnapshot>,
    ) -> OperationItemResult {
        let mut outcome = OperationItemResult {
            item_id: item.id.clone(),
            label: item.label.clone(),
            action: item.action.clone(),
            status: "failed".into(),
            message: String::new(),
            before: item.before.clone(),
            after: Vec::new(),
            recovery: None,
        };
        let mut mutation_started = false;
        let execution: Result<(), String> = (|| {
            // An entirely unchanged batch is verified against the single fresh execution snapshot.
            // Mutating batches still re-read immediately before each item.
            let raw = match prechecked {
                Some(raw) => raw.clone(),
                None => self.system.snapshot()?,
            };
            check_preconditions(item, &raw)?;
            match item.action.as_str() {
                "skip" => {}
                "remove" => {
                    mutation_started = true;
                    self.system.remove(&item.before)?;
                }
                "add" => {
                    mutation_started = true;
                    self.system.add(item.target.as_ref().unwrap())?;
                }
                "metric" => {
                    mutation_started = true;
                    self.system
                        .metric(&item.before, item.target.as_ref().unwrap().metric.unwrap())?;
                }
                "replace" => {
                    mutation_started = true;
                    self.system.remove(&item.before)?;
                    // Do not create replacements over system routes that regenerated after deletion.
                    let current = self.system.snapshot()?;
                    if !remaining_before(&current, &item.before).is_empty() {
                        return Err("原路由仍存在或已被系统重新生成，已停止替换".into());
                    }
                    self.system.add(item.target.as_ref().unwrap())?;
                }
                _ => return Err("无效执行动作".into()),
            }
            let after = if item.action == "skip" {
                raw
            } else {
                self.system.snapshot()?
            };
            outcome.after = affected_records(&after, item);
            let satisfied = match &item.target {
                Some(target) => {
                    target_satisfied(&after, target)
                        && (item.before.is_empty()
                            || item.before[0].key() == target_key(&after, target)?
                            || remaining_before(&after, &item.before).is_empty())
                }
                None => remaining_before(&after, &item.before).is_empty(),
            };
            if !satisfied {
                return Err(
                    "操作后核验未通过：路由仍存在、属性不一致或被系统重新生成，请查看实际状态"
                        .into(),
                );
            }
            if item.save_config {
                self.db
                    .save_route(item.target.as_ref().unwrap().clone())
                    .map_err(|e| format!("系统状态已核验，但保存配置失败：{e}"))?;
            }
            if item.action == "add" || item.action == "replace" {
                for record in &outcome.after {
                    self.db.mark_created(&record.key())?;
                }
            }
            Ok(())
        })();
        match execution {
            Ok(()) => {
                outcome.status = if item.action == "skip" {
                    "skipped"
                } else {
                    "success"
                }
                .into();
                outcome.message = if item.action == "skip" {
                    "已与目标一致，无需系统修改"
                } else {
                    "已执行并重新读取核验"
                }
                .into();
            }
            Err(error) => {
                outcome.message = error;
                if mutation_started && item.action == "replace" && !item.before.is_empty() {
                    outcome.recovery = Some(self.recover_static(item));
                }
                match self.system.snapshot() {
                    Ok(raw) => outcome.after = affected_records(&raw, item),
                    Err(error) => outcome
                        .message
                        .push_str(&format!("；当前状态读取失败：{error}")),
                }
            }
        }
        outcome
    }
    fn recover_static(&mut self, item: &PlanItem) -> String {
        if item.before.iter().any(|r| {
            !matches!(r.protocol.to_lowercase().as_str(), "netmgmt" | "3")
                || r.interface_guid.is_empty()
                || !r.rollback_safe
        }) {
            return "未自动恢复：原记录不是可安全重建的静态路由，请根据记录人工检查".into();
        }
        let recovery: Result<(), String> = (|| {
            let mut raw = self.system.snapshot()?;
            let old = &item.before[0];
            let current_old = records_for(&raw, &old.key());
            if fingerprint(&current_old) == fingerprint(&item.before) {
                return Ok(());
            }
            // Never delete an unexpected record while attempting recovery.
            if !current_old.is_empty() {
                return Err("原位置存在变化后的记录，未覆盖".into());
            }
            if let Some(target) = &item.target {
                if !target_records(&raw, target).is_empty() {
                    return Err("新目标已有记录，无法确认其归属，未自动覆盖；请人工检查".into());
                }
            }
            let persistent = item.before.iter().any(|r| r.store == "PersistentStore");
            let active = item.before.iter().any(|r| r.store == "ActiveStore");
            let original = RouteConfig {
                id: "recovery".into(),
                name: "恢复原路由".into(),
                prefix: old.prefix.clone(),
                gateway: old.gateway.clone(),
                interface_guid: Some(old.interface_guid.clone()),
                metric: Some(old.route_metric),
                persistent,
                comment: String::new(),
            };
            self.system.add(&original)?;
            raw = self.system.snapshot()?;
            if !active {
                let active_rows: Vec<_> = records_for(&raw, &old.key())
                    .into_iter()
                    .filter(|r| r.store == "ActiveStore")
                    .collect();
                self.system.remove(&active_rows)?;
            }
            // Preserve distinct metrics in active/persistent stores.
            raw = self.system.snapshot()?;
            for expected in &item.before {
                let actual: Vec<_> = records_for(&raw, &old.key())
                    .into_iter()
                    .filter(|r| r.store == expected.store)
                    .collect();
                if actual
                    .iter()
                    .any(|r| r.route_metric != expected.route_metric)
                {
                    self.system.metric(&actual, expected.route_metric)?;
                }
            }
            raw = self.system.snapshot()?;
            if fingerprint(&records_for(&raw, &old.key())) != fingerprint(&item.before) {
                return Err("恢复后的记录与原记录不完全一致".into());
            }
            Ok(())
        })();
        match recovery {
            Ok(()) => "原静态路由已恢复并核验".into(),
            Err(error) => format!("自动恢复未完成：{error}"),
        }
    }
}
fn resolve_interface(
    raw: &SystemSnapshot,
    target: &mut RouteConfig,
    before: &[RouteRecord],
) -> Result<(), String> {
    if target.interface_guid.is_none() && !before.is_empty() && !before[0].interface_guid.is_empty()
    {
        target.interface_guid = Some(before[0].interface_guid.clone());
    }
    if target.interface_guid.is_none() {
        let gateway: std::net::Ipv4Addr = target.gateway.parse().map_err(|_| "IPv4 网关无效")?;
        let candidates: Vec<_> = raw
            .interfaces
            .iter()
            .filter(|interface| {
                interface.status == "Up"
                    && gateway != std::net::Ipv4Addr::UNSPECIFIED
                    && interface.addresses.iter().any(|address| {
                        address
                            .parse::<ipnet::Ipv4Net>()
                            .is_ok_and(|net| net.contains(&gateway))
                    })
            })
            .collect();
        if candidates.len() != 1 {
            return Err(format!(
                "{}：无法唯一确定网卡，请在配置中选择接口",
                target.name
            ));
        }
        target.interface_guid = Some(candidates[0].guid.clone());
    }
    let interface = raw
        .interfaces
        .iter()
        .find(|i| Some(&i.guid) == target.interface_guid.as_ref())
        .ok_or("配置中的网卡不存在，请重新选择")?;
    if interface.status != "Up" {
        return Err(format!("接口 {} 当前未连接", interface.alias));
    }
    Ok(())
}
fn make_upsert(
    raw: &SystemSnapshot,
    mut target: RouteConfig,
    mut before: Vec<RouteRecord>,
    save_config: bool,
) -> Result<PlanItem, String> {
    normalize_config(&mut target)?;
    resolve_interface(raw, &mut target, &before)?;
    let existing_target = target_records(raw, &target);
    if before.is_empty() {
        before = existing_target.clone();
    } else if !existing_target.is_empty() && existing_target[0].key() != before[0].key() {
        return Err(format!(
            "{}：新目标已有另一条路由，不能隐式覆盖",
            target.name
        ));
    }
    if before.iter().any(|r| r.family != "IPv4") {
        return Err("IPv6 仅支持查看".into());
    }
    let same_key = !before.is_empty()
        && before[0].prefix == target.prefix
        && before[0].gateway == target.gateway
        && target.interface_guid.as_deref() == Some(before[0].logical_guid());
    let already_satisfied = same_key && target_satisfied(raw, &target);
    if target.metric.is_none() && !already_satisfied && !before.is_empty() {
        target.metric = Some(
            before
                .iter()
                .find(|r| r.store == "ActiveStore")
                .unwrap_or(&before[0])
                .route_metric,
        );
    }
    let same_persistence = target.persistent == before.iter().any(|r| r.store == "PersistentStore");
    let action = if before.is_empty() {
        "add"
    } else if already_satisfied {
        "skip"
    } else if same_key && same_persistence && before.iter().any(|r| r.store == "ActiveStore") {
        "metric"
    } else {
        "replace"
    };
    let mut warnings = warnings_for(&before, Some(&target));
    if action == "replace" && before.iter().any(|r| !r.rollback_safe) {
        warnings.push("原记录含无接口持久信息、动态或特殊属性，替换失败时可能需要人工恢复；操作记录会保留修改前数据".into());
    }
    Ok(PlanItem {
        id: uuid::Uuid::new_v4().to_string(),
        label: target.name.clone(),
        action: action.into(),
        before,
        target: Some(target),
        save_config,
        warnings,
    })
}
fn target_key(raw: &SystemSnapshot, target: &RouteConfig) -> Result<String, String> {
    target_records(raw, target)
        .first()
        .map(|r| r.key())
        .ok_or("目标路由不存在".into())
}
fn check_persistent_scope(item: &PlanItem, raw: &SystemSnapshot) -> Result<(), String> {
    for record in &raw.routes {
        let relevant = item
            .before
            .iter()
            .any(|b| b.prefix == record.prefix && b.gateway == record.gateway)
            || item
                .target
                .as_ref()
                .is_some_and(|t| t.prefix == record.prefix && t.gateway == record.gateway);
        if relevant
            && unassociated_persistent(record)
            && !item.before.iter().any(|b| same_physical_record(record, b))
        {
            return Err(format!(
                "{}：存在无法唯一关联接口的旧持久记录，请先在当前路由中单独检查该持久记录",
                item.label
            ));
        }
    }
    Ok(())
}
fn check_preconditions(item: &PlanItem, raw: &SystemSnapshot) -> Result<(), String> {
    check_persistent_scope(item, raw)?;
    if !item.before.is_empty()
        && fingerprint(&records_for(raw, &item.before[0].key())) != fingerprint(&item.before)
    {
        return Err(format!("{}：系统路由已变化，请重新预览", item.label));
    }
    if let Some(target) = &item.target {
        let mut resolved = target.clone();
        resolve_interface(raw, &mut resolved, &item.before)?;
        let current_target = target_records(raw, target);
        if (item.before.is_empty()
            || item.before[0].key() != current_target.first().map(|r| r.key()).unwrap_or_default())
            && !current_target.is_empty()
        {
            return Err(format!("{}：目标位置已有新路由，请重新预览", item.label));
        }
    }
    Ok(())
}
fn affected_records(raw: &SystemSnapshot, item: &PlanItem) -> Vec<RouteRecord> {
    let mut result = remaining_before(raw, &item.before);
    if let Some(target) = &item.target {
        for record in target_records(raw, target) {
            if !result.contains(&record) {
                result.push(record);
            }
        }
    }
    result
}
fn warnings_for(before: &[RouteRecord], target: Option<&RouteConfig>) -> Vec<String> {
    let mut warnings = Vec::new();
    if before.iter().any(|r| r.prefix == "0.0.0.0/0")
        || target.is_some_and(|t| t.prefix == "0.0.0.0/0")
    {
        warnings.push("涉及默认路由，可能改变当前网络出口或中断连接".into());
    }
    if before.iter().any(is_system) {
        warnings.push("涉及系统自动／动态路由，系统可能拒绝修改或再次生成".into());
    }
    warnings
}
