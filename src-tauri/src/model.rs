use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RouteConfig {
    pub id: String,
    pub name: String,
    pub prefix: String,
    pub gateway: String,
    #[serde(default)]
    pub interface_guid: Option<String>,
    #[serde(default)]
    pub metric: Option<u16>,
    #[serde(default)]
    pub persistent: bool,
    #[serde(default)]
    pub comment: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RouteGroup {
    pub id: String,
    pub name: String,
    pub routes: Vec<String>,
}
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Library {
    pub routes: Vec<RouteConfig>,
    pub groups: Vec<RouteGroup>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NetworkInterface {
    pub guid: String,
    pub index: u32,
    pub alias: String,
    pub status: String,
    #[serde(default)]
    pub addresses: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RouteRecord {
    pub family: String,
    pub prefix: String,
    pub gateway: String,
    pub interface_index: u32,
    pub interface_guid: String,
    #[serde(default)]
    pub associated_interface_guid: Option<String>,
    pub interface_alias: String,
    pub route_metric: u16,
    pub interface_metric: u32,
    pub protocol: String,
    #[serde(default)]
    pub rollback_safe: bool,
    pub store: String,
}
impl RouteRecord {
    pub fn logical_guid(&self) -> &str {
        self.associated_interface_guid
            .as_deref()
            .unwrap_or(&self.interface_guid)
    }
    pub fn key(&self) -> String {
        let interface = if self.logical_guid().is_empty() {
            format!("index:{}", self.interface_index)
        } else {
            self.logical_guid().to_lowercase()
        };
        format!(
            "{}|{}|{}|{}",
            self.family, self.prefix, self.gateway, interface
        )
    }
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SystemSnapshot {
    pub routes: Vec<RouteRecord>,
    pub interfaces: Vec<NetworkInterface>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteView {
    pub key: String,
    pub records: Vec<RouteRecord>,
    pub config_ids: Vec<String>,
    pub ambiguous_config_ids: Vec<String>,
    pub ownership: String,
    pub created_by_app: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteMatch {
    pub config_id: String,
    pub state: String,
    pub route_keys: Vec<String>,
    pub reason: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteSnapshot {
    pub captured_at: String,
    pub routes: Vec<RouteView>,
    pub interfaces: Vec<NetworkInterface>,
    pub matches: Vec<RouteMatch>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanRequest {
    pub action: String,
    #[serde(default)]
    pub config_ids: Vec<String>,
    #[serde(default)]
    pub route_keys: Vec<String>,
    #[serde(default)]
    pub draft: Option<RouteConfig>,
    #[serde(default)]
    pub source_key: Option<String>,
    #[serde(default)]
    pub save_config: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanItem {
    pub id: String,
    pub label: String,
    pub action: String,
    pub before: Vec<RouteRecord>,
    pub target: Option<RouteConfig>,
    pub save_config: bool,
    pub warnings: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperationPlan {
    pub id: String,
    pub created_at: String,
    pub items: Vec<PlanItem>,
    pub warnings: Vec<String>,
    pub library_fingerprint: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperationItemResult {
    pub item_id: String,
    pub label: String,
    pub action: String,
    pub status: String,
    pub message: String,
    pub before: Vec<RouteRecord>,
    pub after: Vec<RouteRecord>,
    pub recovery: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperationResult {
    pub id: String,
    pub started_at: String,
    pub finished_at: String,
    pub status: String,
    pub items: Vec<OperationItemResult>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostsDocument {
    pub content: String,
    pub fingerprint: String,
    pub encoding: String,
    pub newline: String,
    pub path: String,
}
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
pub fn hash(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}
