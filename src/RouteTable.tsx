import { useMemo, useState } from 'react';
import { Badge, Button, Checkbox, Input, Select } from '@fluentui/react-components';
import { activeRecord, filterRoutes, ownerLabels, persistence } from './domain';
import type { Library, RouteView } from './types';
import { Empty, Icon } from './components';

export function RouteTable({ rows, library, selected, onSelected, onDetail }: {
  rows: RouteView[]; library: Library; selected: Set<string>; onSelected: (keys: Set<string>) => void; onDetail: (row: RouteView) => void;
}) {
  const [filters, setFilters] = useState({ search: '', owner: '', family: '', network: '', persistent: '' });
  const [sort, setSort] = useState<{ column: 'prefix' | 'gateway' | 'metric' | 'interface'; ascending: boolean }>({ column: 'prefix', ascending: true });
  const networks = [...new Map(rows.map(row => { const r = activeRecord(row); return [r.interface_index, r.interface_alias] as const; })).entries()];
  const visible = useMemo(() => {
    const result = filterRoutes(rows, filters, library);
    return result.sort((a, b) => {
      const ar = activeRecord(a), br = activeRecord(b);
      const value = sort.column === 'metric' ? (ar.route_metric + ar.interface_metric) - (br.route_metric + br.interface_metric)
        : (sort.column === 'interface' ? ar.interface_alias : ar[sort.column]).localeCompare(sort.column === 'interface' ? br.interface_alias : br[sort.column], 'en', { numeric: true });
      return sort.ascending ? value : -value;
    });
  }, [rows, filters, sort, library]);
  const writable = visible.filter(row => activeRecord(row).family === 'IPv4');
  const allSelected = writable.length > 0 && writable.every(r => selected.has(r.key));
  const anySelected = writable.some(r => selected.has(r.key));
  const toggle = (key: string) => { const next = new Set(selected); if (next.has(key)) next.delete(key); else next.add(key); onSelected(next); };
  const toggleAll = () => {
    const next = new Set(selected);
    for (const row of writable) { if (allSelected) next.delete(row.key); else next.add(row.key); }
    onSelected(next);
  };
  const heading = (name: string, column: typeof sort.column) => <button className="sort-button" onClick={() => setSort({ column, ascending: sort.column === column ? !sort.ascending : true })}>{name}<span>{sort.column === column ? (sort.ascending ? '↑' : '↓') : '↕'}</span></button>;
  return <section className="table-card">
    <div className="table-toolbar">
      <Input aria-label="搜索路由" className="search-input" contentBefore={<Icon name="search" size={17}/>} placeholder="搜索目标、网关、接口或配置名称" value={filters.search} onChange={(_, d) => setFilters({ ...filters, search: d.value })}/>
      <Select aria-label="管理归属" value={filters.owner} onChange={(_, d) => setFilters({ ...filters, owner: d.value })}><option value="">全部归属</option>{Object.entries(ownerLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select>
      <Select aria-label="地址族" value={filters.family} onChange={(_, d) => setFilters({ ...filters, family: d.value })}><option value="">IPv4 + IPv6</option><option>IPv4</option><option>IPv6</option></Select>
      <Select aria-label="网络接口筛选" value={filters.network} onChange={(_, d) => setFilters({ ...filters, network: d.value })}><option value="">全部接口</option>{networks.map(([index, name]) => <option key={index} value={index}>{name}</option>)}</Select>
      <Select aria-label="持久状态筛选" value={filters.persistent} onChange={(_, d) => setFilters({ ...filters, persistent: d.value })}><option value="">全部状态</option><option>持久</option><option>临时</option><option>仅持久记录</option></Select>
    </div>
    <div className="table-scroll">
      <table className="route-table">
        <thead><tr>
          <th className="check-cell"><Checkbox aria-label="选择当前筛选中的所有 IPv4 路由" checked={allSelected ? true : anySelected ? 'mixed' : false} onChange={toggleAll}/></th>
          <th aria-sort={sort.column === 'prefix' ? (sort.ascending ? 'ascending' : 'descending') : 'none'}>{heading('目标网段', 'prefix')}</th>
          <th>{heading('网关', 'gateway')}</th><th>{heading('网络接口', 'interface')}</th>
          <th>{heading('有效 metric', 'metric')}</th><th>持久状态</th><th>管理归属</th><th>协议</th><th>匹配配置</th><th className="detail-cell"/>
        </tr></thead>
        <tbody>{visible.map(row => {
          const r = activeRecord(row);
          const names = library.routes.filter(c => row.config_ids.includes(c.id)).map(c => c.name);
          return <tr key={row.key} className={selected.has(row.key) ? 'selected' : ''}>
            <td className="check-cell"><Checkbox aria-label={`选择 ${r.prefix} 经 ${r.gateway} 接口 ${r.interface_alias}`} checked={selected.has(row.key)} disabled={r.family !== 'IPv4'} onChange={() => toggle(row.key)}/></td>
            <td><button className="route-link mono" onClick={() => onDetail(row)}>{r.prefix}</button>{r.family === 'IPv6' && <small className="readonly-label">IPv6 · 只读</small>}</td>
            <td className="mono">{r.gateway}</td>
            <td><span className="interface-label"><span className="interface-dot"/>{r.interface_alias}</span><small className="muted">if {r.interface_index}</small></td>
            <td><span className="metric-total">{r.route_metric + r.interface_metric}</span><small className="muted">{r.route_metric} + {r.interface_metric}</small></td>
            <td><Badge appearance="outline" color={persistence(row) === '持久' ? 'brand' : 'informative'}>{persistence(row)}</Badge></td>
            <td><span className={`ownership ${row.ownership}`}><span/>{ownerLabels[row.ownership]}</span>{row.ambiguous_config_ids.length > 0 && <small className="warning-text">接口待确认</small>}</td>
            <td className="muted protocol">{r.protocol}</td><td className="config-cell" title={names.join('、')}>{names.join('、') || '—'}</td>
            <td><Button size="small" appearance="subtle" aria-label={`查看 ${r.prefix} 详情`} icon={<Icon name="arrow" size={16}/>} onClick={() => onDetail(row)}/></td>
          </tr>;
        })}</tbody>
      </table>
      {!visible.length && <Empty title={rows.length ? '没有匹配的路由' : '暂无路由数据'} text={rows.length ? '尝试调整搜索词或筛选条件。' : '刷新以读取本机路由。读取失败时会在上方显示原因。'}/>}
    </div>
    <div className="table-footer"><span>显示 {visible.length} / {rows.length} 条路由 · 已选 {selected.size} 条</span><span>IPv6 只读 · 来源标签不代表创建程序</span></div>
  </section>;
}
