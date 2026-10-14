import type { Library, RouteConfig, RouteRecord, RouteView } from './types';
export const stateLabels: Record<string, string> = {
  active: '已生效', inactive: '未生效', persistent_only: '仅持久记录', drifted: '配置不一致', ambiguous: '接口待确认',
  success: '成功', skipped: '已跳过', partial: '部分失败', failed: '失败', pending: '待执行', running: '执行中', interrupted: '意外中断',
};
export const actionLabels: Record<string, string> = { add: '新增', remove: '移除', metric: '修改 metric', replace: '替换', skip: '无需修改' };
export const ownerLabels = { managed: '本管理器管理', system: '系统自动 / 动态', other: '其他 / 来源未知' };
export function activeRecord(row: RouteView): RouteRecord { return row.records.find(r => r.store === 'ActiveStore') ?? row.records[0]; }
export function persistence(row: RouteView): string {
  const active = row.records.some(r => r.store === 'ActiveStore');
  const persistent = row.records.some(r => r.store === 'PersistentStore');
  return persistent ? (active ? '持久' : '仅持久记录') : '临时';
}
export function fromRoute(row: RouteView, library: Library): RouteConfig {
  const config = library.routes.find(c => row.config_ids.includes(c.id));
  const r = activeRecord(row);
  return {
    id: config?.id ?? crypto.randomUUID(), name: config?.name ?? r.prefix,
    prefix: r.prefix, gateway: r.gateway, interface_guid: r.interface_guid || null,
    metric: r.route_metric, persistent: row.records.some(r => r.store === 'PersistentStore'), comment: config?.comment ?? '',
  };
}
export interface RouteFilters { search: string; owner: string; family: string; network: string; persistent: string }
export function filterRoutes(rows: RouteView[], filters: RouteFilters, library: Library): RouteView[] {
  const query = filters.search.trim().toLowerCase();
  return rows.filter(row => {
    const r = activeRecord(row);
    const names = library.routes.filter(c => row.config_ids.includes(c.id)).map(c => c.name).join(' ');
    return (!filters.owner || row.ownership === filters.owner)
      && (!filters.family || r.family === filters.family)
      && (!filters.network || String(r.interface_index) === filters.network)
      && (!filters.persistent || persistence(row) === filters.persistent)
      && (!query || [r.prefix, r.gateway, r.interface_alias, names, r.protocol].join(' ').toLowerCase().includes(query));
  });
}
export function validateDraft(config: RouteConfig): string | null {
  if (!config.name.trim()) return '请输入名称';
  const [ip, bits, extra] = config.prefix.split('/');
  const validIp = (text: string) => /^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(text) && text.split('.').every(s => Number(s) <= 255);
  if (extra !== undefined || !validIp(ip) || !/^\d{1,2}$/.test(bits ?? '') || Number(bits) > 32) return '请输入 IPv4 CIDR 网段，例如 203.0.113.0/24';
  if (!validIp(config.gateway)) return '请输入 IPv4 网关，直连路由可填 0.0.0.0';
  if (config.metric !== null && (!Number.isInteger(config.metric) || config.metric < 0 || config.metric > 65535)) return 'metric 必须为 0–65535 的整数';
  return null;
}
export function formatTime(value: string): string { return new Date(value).toLocaleString('zh-CN', { hour12: false }); }
