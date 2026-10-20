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
    prefix: r.prefix, gateway: r.gateway, interface_id: r.interface_id || null,
    scope: row.records.some(r => r.store === 'PersistentStore') ? null : r.native?.scope === 'scoped' ? 'scoped' : r.native ? 'unscoped' : null,
    metric: r.interface_id.startsWith('macos:') ? null : r.route_metric, persistent: row.records.some(r => r.store === 'PersistentStore'), comment: config?.comment ?? '',
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
const validIp = (text: string) => /^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(text) && text.split('.').every(s => Number(s) <= 255);
export function validateDraft(config: RouteConfig): string | null {
  if (!config.name.trim()) return '请输入名称';
  const [ip, bits, extra] = config.prefix.split('/');
  if (extra !== undefined || !validIp(ip) || !/^\d{1,2}$/.test(bits ?? '') || Number(bits) > 32) return '请输入 IPv4 CIDR 网段，例如 203.0.113.0/24';
  if (!validIp(config.gateway)) return '请输入 IPv4 网关，直连路由可填 0.0.0.0';
  if (config.metric !== null && (!Number.isInteger(config.metric) || config.metric < 0 || config.metric > 65535)) return 'metric 必须为 0–65535 的整数';
  if (config.scope && (config.persistent || (config.interface_id && !config.interface_id.startsWith('macos:')))) return '路由作用域仅适用于 macOS 临时路由';
  return null;
}

export function copyConfig(config: RouteConfig, routes: RouteConfig[]): RouteConfig {
  const base = `${config.name}（副本）`;
  let name = base;
  for (let index = 2; routes.some(route => route.name === name); index += 1) name = `${base} ${index}`;
  return { ...config, id: crypto.randomUUID(), name };
}

// Match the backend's identity check, including normalization to the network address.
export function validateConfigs(routes: RouteConfig[]): string | null {
  const identities = new Map<string, string>();
  for (const route of routes) {
    const invalid = validateDraft(route);
    if (invalid) return `${route.name || '未命名配置'}：${invalid}`;
    const [ip, bits] = route.prefix.split('/');
    const address = ip.split('.').reduce((value, octet) => (value * 256) + Number(octet), 0);
    const network = Number(bits) === 0 ? 0 : (address & (0xffffffff << (32 - Number(bits)))) >>> 0;
    const identity = JSON.stringify([network, Number(bits), route.gateway, route.interface_id?.toLowerCase() || null, route.scope ?? null]);
    const existing = identities.get(identity);
    if (existing) return `“${route.name}”与“${existing}”的路由重复，请调整目标网段、网关或网络接口。`;
    identities.set(identity, route.name);
  }
  return null;
}

export function gatewayOptions(rows: RouteView[]): { address: string; interfaces: string[] }[] {
  const gateways = new Map<string, Set<string>>();
  for (const row of rows) for (const record of row.records) {
    if (record.family !== 'IPv4' || !validIp(record.gateway)) continue;
    const aliases = gateways.get(record.gateway) ?? new Set<string>();
    if (record.interface_alias) aliases.add(record.interface_alias);
    gateways.set(record.gateway, aliases);
  }
  return [...gateways].sort(([a], [b]) => a === '0.0.0.0' ? 1 : b === '0.0.0.0' ? -1 : a.localeCompare(b, undefined, { numeric: true }))
    .map(([address, interfaces]) => ({ address, interfaces: [...interfaces].sort() }));
}

export type ConfigPatch = Partial<Pick<RouteConfig, 'prefix' | 'gateway' | 'interface_id' | 'metric' | 'persistent' | 'comment' | 'scope'>>;
export function patchConfigs(routes: RouteConfig[], ids: string[], patch: ConfigPatch): RouteConfig[] {
  const selected = new Set(ids);
  return routes.map(route => {
    if (!selected.has(route.id)) return route;
    const next = { ...route, ...patch };
    if (patch.persistent !== undefined && patch.scope === undefined) {
      if (next.persistent && next.scope != null) next.scope = null;
      else if (!next.persistent && route.persistent && !next.scope && next.interface_id?.startsWith('macos:')) next.scope = 'unscoped';
    }
    if (patch.interface_id?.startsWith('windows:') && patch.scope === undefined && next.scope != null) next.scope = null;
    return next;
  });
}
export function formatTime(value: string): string { return new Date(value).toLocaleString('zh-CN', { hour12: false }); }
