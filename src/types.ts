export interface RouteConfig {
  id: string; name: string; prefix: string; gateway: string; interface_guid: string | null;
  metric: number | null; persistent: boolean; comment: string;
}
export interface RouteGroup { id: string; name: string; routes: string[] }
export interface Library { routes: RouteConfig[]; groups: RouteGroup[] }
export interface NetworkInterface { guid: string; index: number; alias: string; status: string; addresses: string[] }
export interface RouteRecord {
  family: string; prefix: string; gateway: string; interface_index: number; interface_guid: string;
  interface_alias: string; route_metric: number; interface_metric: number; protocol: string; store: string;
  associated_interface_guid?: string | null;
}
export interface RouteView {
  key: string; records: RouteRecord[]; config_ids: string[]; ambiguous_config_ids: string[];
  ownership: 'managed' | 'system' | 'other'; created_by_app: boolean;
}
export interface RouteMatch { config_id: string; state: string; route_keys: string[]; reason: string }
export interface RouteSnapshot { captured_at: string; routes: RouteView[]; interfaces: NetworkInterface[]; matches: RouteMatch[] }
export interface PlanRequest {
  action: 'apply' | 'remove' | 'clear_managed' | 'upsert'; config_ids?: string[]; route_keys?: string[];
  draft?: RouteConfig; source_key?: string | null; save_config?: boolean;
}
export interface PlanItem {
  id: string; label: string; action: string; before: RouteRecord[];
  target: RouteConfig | null; save_config: boolean; warnings: string[];
}
export interface OperationPlan { id: string; created_at: string; items: PlanItem[]; warnings: string[]; library_fingerprint: string }
export interface OperationItemResult {
  item_id: string; label: string; action: string; status: string; message: string;
  before: RouteRecord[]; after: RouteRecord[]; recovery: string | null;
}
export interface OperationResult { id: string; started_at: string; finished_at: string; status: string; items: OperationItemResult[] }
export interface HostsDocument { content: string; fingerprint: string; encoding: string; newline: string; path: string }
export interface Settings { theme: 'light' | 'dark' | 'system'; refresh_seconds: number; data_dir: string; version: string }
