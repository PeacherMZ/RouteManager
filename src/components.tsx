import { useState } from 'react';
import { Badge, Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle,
  Field, Input, Select, Switch, Textarea } from '@fluentui/react-components';
import type { Library, NetworkInterface, OperationPlan, OperationResult, RouteConfig, RouteGroup } from './types';
import { actionLabels, formatTime, stateLabels, validateDraft } from './domain';
import { usePlatform } from './platform';

export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, string> = {
    routes: 'M4 5h5v5H4z M15 14h5v5h-5z M9 7.5h4a4 4 0 0 1 4 4V14 M6.5 10v7h8.5',
    library: 'M4 4h5v16H4z M11 4h4v16h-4z M17 5l3-1 4 15-3 1z',
    history: 'M4 8a9 9 0 1 1-1 7 M4 3v5h5 M12 7v5l4 2',
    hosts: 'M4 3h10l5 5v13H4z M14 3v6h5 M8 13h7 M8 17h5',
    settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M10 2h4l1 3 3 1 3-1 2 4-2 2v3l2 2-2 4-3-1-3 1-1 3h-4l-1-3-3-1-3 1-2-4 2-2v-3L1 9l2-4 3 1 3-1z',
    refresh: 'M20 7a9 9 0 0 0-15-2L2 8 M2 2v6h6 M4 17a9 9 0 0 0 15 2l3-3 M22 22v-6h-6',
    plus: 'M12 5v14 M5 12h14',
    arrow: 'M5 12h14 M14 7l5 5-5 5',
    close: 'M6 6l12 12 M18 6 6 18',
    shield: 'M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6z M8 12l3 3 5-6',
    search: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M15 15l6 6',
    check: 'M5 12l4 4L19 6',
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={paths[name] ?? paths.routes}/></svg>;
}
export function StateBadge({ value }: { value: string }) {
  const color = ['active', 'success'].includes(value) ? 'success' : ['failed', 'interrupted'].includes(value) ? 'danger'
    : ['ambiguous', 'drifted', 'partial', 'persistent_only'].includes(value) ? 'warning' : 'informative';
  return <Badge appearance="tint" color={color}>{stateLabels[value] ?? value}</Badge>;
}
export function Empty({ title, text }: { title: string; text: string }) {
  return <div className="empty"><span className="empty-icon"><Icon name="routes" size={32}/></span><h3>{title}</h3><p>{text}</p></div>;
}
export function RouteEditor({ initial, interfaces, system, busy, onClose, onSave }: {
  initial: RouteConfig; interfaces: NetworkInterface[]; system: boolean; busy: boolean;
  onClose: () => void; onSave: (draft: RouteConfig, save: boolean) => Promise<boolean>;
}) {
  const platform = usePlatform();
  const [draft, setDraft] = useState(() => ({ ...initial, metric: platform.metric ? initial.metric : null, scope: platform.os === 'macos' && !initial.persistent ? initial.scope ?? 'unscoped' : null }));
  const [save, setSave] = useState(true);
  const [error, setError] = useState('');
  const patch = (value: Partial<RouteConfig>) => setDraft(old => ({ ...old, ...value }));
  const submit = async () => {
    const invalid = validateDraft(draft);
    if (invalid) { setError(invalid); return; }
    setError('');
    if (await onSave(draft, save)) onClose();
  };
  return <Dialog open onOpenChange={(_, data) => { if (!data.open && !busy) onClose(); }}>
    <DialogSurface className="editor-dialog"><DialogBody>
      <DialogTitle>{system ? '设置系统路由' : '编辑路由配置'}</DialogTitle>
      <DialogContent>
        <p className="muted">{system ? '确认参数后先查看变更预览，再执行系统修改。' : '保存只更新配置库，应用配置后才会改变系统路由。'}</p>
        <div className="form-grid">
          <Field label="名称" required className="full"><Input value={draft.name} onChange={(_, d) => patch({ name: d.value })}/></Field>
          <Field label="目标网段 / 前缀长度" required><Input value={draft.prefix} placeholder="203.0.113.0/24" onChange={(_, d) => patch({ prefix: d.value })}/></Field>
          <Field label="网关" required><Input value={draft.gateway} placeholder="192.0.2.1" onChange={(_, d) => patch({ gateway: d.value })}/></Field>
          <Field label="网络接口" className="full" hint="自动匹配无法确定唯一接口时，程序会要求你明确选择。">
            <Select value={draft.interface_id ?? ''} onChange={(_, d) => patch({ interface_id: d.value || null, ...(d.value.startsWith('macos:') && d.value.endsWith(':-') ? { persistent: false, scope: 'unscoped' } : {}) })}>
              <option value="">自动匹配（必须唯一）</option>
              {draft.interface_id && !interfaces.some(i => i.guid === draft.interface_id) && <option value={draft.interface_id}>已保存接口（当前不可用）</option>}
              {interfaces.map(i => <option key={i.guid} value={i.guid}>{i.alias} · {i.addresses.join(', ') || '无 IPv4'} {i.status !== 'Up' ? '· 未连接' : ''}</option>)}
            </Select>
          </Field>
          <Field label="路由 metric" hint={platform.metric ? '留空时保留现值；新建使用系统默认值。' : 'macOS 不适用；保存时清除 Windows metric。'}><Input disabled={!platform.metric} type="number" min={0} max={65535} value={draft.metric === null ? '' : String(draft.metric)} onChange={(_, d) => patch({ metric: d.value === '' ? null : Number(d.value) })}/></Field>
          <Field label="持久路由" hint={platform.os === 'macos' ? '使用系统网络服务保存；没有唯一网络服务的接口仅支持临时路由。' : undefined}><Switch disabled={!platform.persistent_routes || (draft.interface_id?.startsWith('macos:') && draft.interface_id.endsWith(':-') && !draft.persistent)} checked={draft.persistent} label="重启后保留" onChange={(_, d) => patch({ persistent: d.checked, scope: platform.os === 'macos' && !d.checked ? draft.scope ?? 'unscoped' : null })}/></Field>
          {platform.os === 'macos' && !draft.persistent && <Field label="路由作用域" hint="接口限定路由只用于相应接口；修改时保留所选作用域。"><Select value={draft.scope ?? 'unscoped'} onChange={(_, d) => patch({ scope: d.value as 'scoped' | 'unscoped' })}><option value="unscoped">全局</option><option value="scoped">接口限定</option></Select></Field>}
          <Field label="备注" className="full"><Textarea resize="vertical" value={draft.comment} onChange={(_, d) => patch({ comment: d.value })}/></Field>
          {system && <Checkbox className="full" checked={save} label="同步保存到配置库" onChange={(_, d) => setSave(d.checked === true)}/>}
        </div>
        {error && <p role="alert" className="error-text">{error}</p>}
      </DialogContent>
      <DialogActions><Button disabled={busy} onClick={onClose}>取消</Button><Button appearance="primary" disabled={busy} onClick={() => void submit()}>{system ? '查看变更预览' : '保存配置'}</Button></DialogActions>
    </DialogBody></DialogSurface>
  </Dialog>;
}
export function GroupEditor({ initial, library, busy, onClose, onSave }: {
  initial: RouteGroup; library: Library; busy: boolean; onClose: () => void; onSave: (group: RouteGroup) => Promise<boolean>;
}) {
  const [group, setGroup] = useState(initial);
  const move = (index: number, direction: number) => {
    const routes = [...group.routes];
    [routes[index], routes[index + direction]] = [routes[index + direction], routes[index]];
    setGroup({ ...group, routes });
  };
  return <Dialog open onOpenChange={(_, d) => { if (!d.open && !busy) onClose(); }}><DialogSurface><DialogBody>
    <DialogTitle>编辑路由分组</DialogTitle><DialogContent>
      <Field label="分组名称" required><Input value={group.name} onChange={(_, d) => setGroup({ ...group, name: d.value })}/></Field>
      <p className="muted">勾选成员，在下方调整应用顺序。同一路由可以属于多个分组。</p>
      <div className="member-list">{library.routes.map(route => <Checkbox key={route.id} checked={group.routes.includes(route.id)} label={route.name} onChange={(_, d) => setGroup({ ...group, routes: d.checked ? [...group.routes, route.id] : group.routes.filter(id => id !== route.id) })}/>)}</div>
      <ol className="ordered-members">{group.routes.map((id, i) => <li key={id}><span>{library.routes.find(r => r.id === id)?.name ?? id}</span><Button size="small" disabled={i === 0} onClick={() => move(i, -1)}>上移</Button><Button size="small" disabled={i === group.routes.length - 1} onClick={() => move(i, 1)}>下移</Button></li>)}</ol>
    </DialogContent><DialogActions><Button onClick={onClose} disabled={busy}>取消</Button><Button appearance="primary" disabled={!group.name.trim() || busy} onClick={async () => { if (await onSave(group)) onClose(); }}>保存分组</Button></DialogActions>
  </DialogBody></DialogSurface></Dialog>;
}
export function PlanDialog({ plan, busy, onClose, onConfirm }: { plan: OperationPlan; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  const changes = plan.items.filter(i => i.action !== 'skip').length;
  return <Dialog open modalType={busy ? 'alert' : 'modal'} onOpenChange={(_, d) => { if (!d.open && !busy) onClose(); }}><DialogSurface className="wide-dialog"><DialogBody>
    <DialogTitle>确认路由变更 <span className="title-count">{changes} 项修改</span></DialogTitle>
    <DialogContent>
      <p className="muted">仅执行下方列出的变更。执行前会再次核对实际路由，完成后重新读取验证。</p>
      {[...new Set([...plan.warnings, ...plan.items.flatMap(i => i.warnings)])].map(w => <div key={w} className="warning-banner">{w}</div>)}
      <div className="plan-items">{plan.items.map(item => <section className="plan-item" key={item.id}>
        <div className="section-heading"><strong>{item.label}</strong><Badge appearance="tint" color={item.action === 'remove' ? 'danger' : 'informative'}>{actionLabels[item.action]}</Badge></div>
        <div className="diff-columns"><div><span className="eyebrow">当前状态</span>{item.before.length ? item.before.map(r => <div key={`${r.store}|${r.native?.scope ?? ""}`} className="mono">{r.prefix} → {r.gateway}<small>{r.interface_alias} · metric {r.interface_id.startsWith('macos:') ? '不适用' : r.route_metric} · {r.store === 'ActiveStore' ? '当前生效' : '持久记录'}{r.native && ` · ${r.native.scope === 'scoped' ? '接口限定' : r.native.scope === 'ambiguous' ? '作用域待确认' : '全局'}`}</small></div>) : <p className="muted">不存在</p>}</div>
          <Icon name="arrow"/><div><span className="eyebrow">执行后</span>{item.target ? <div className="mono">{item.target.prefix} → {item.target.gateway}<small>metric {item.target.interface_id?.startsWith('macos:') ? '不适用' : item.target.metric ?? '默认'} · {item.target.persistent ? '活动 + 持久记录' : '仅活动记录'}{item.target.scope && ` · ${item.target.scope === 'scoped' ? '接口限定' : '全局'}`}</small></div> : <p>移除对应活动与持久记录</p>}</div>
        </div>
        <small className="muted">{item.save_config ? '成功核验后同步保存配置' : '保留现有配置库'}</small>
      </section>)}</div>
    </DialogContent><DialogActions><Button disabled={busy} onClick={onClose}>取消</Button><Button appearance="primary" disabled={busy} onClick={onConfirm}>{busy ? '正在执行并核验…' : '确认执行'}</Button></DialogActions>
  </DialogBody></DialogSurface></Dialog>;
}
export function ResultDialog({ result, onClose }: { result: OperationResult; onClose: () => void }) {
  return <Dialog open onOpenChange={(_, d) => { if (!d.open) onClose(); }}><DialogSurface className="wide-dialog"><DialogBody>
    <DialogTitle>操作结果 <StateBadge value={result.status}/></DialogTitle><DialogContent className="result-items">
      <p className="muted">{formatTime(result.started_at)}</p>
      {result.items.map(item => <div key={item.item_id} className="result-item"><div className="section-heading"><strong>{item.label}</strong><StateBadge value={item.status}/></div><p>{item.message}</p>{item.recovery && <p className="warning-banner">{item.recovery}</p>}
        <details><summary>查看变更前后记录</summary><div className="diff-columns"><div><span className="eyebrow">执行前</span>{item.before.length ? item.before.map(r => <div className="mono" key={`${r.store}|${r.prefix}|${r.gateway}|${r.interface_index}|${r.native?.scope ?? ""}`}>{r.prefix} → {r.gateway}<small>{r.interface_alias} · metric {r.interface_id.startsWith('macos:') ? '不适用' : r.route_metric} · {r.store === 'ActiveStore' ? '当前生效' : '持久记录'}{r.native && ` · ${r.native.scope === 'scoped' ? '接口限定' : r.native.scope === 'ambiguous' ? '作用域待确认' : '全局'}`}</small></div>) : <span className="muted">无记录</span>}</div>
        <Icon name="arrow"/><div><span className="eyebrow">执行后实际状态</span>{item.after.length ? item.after.map(r => <div className="mono" key={`${r.store}|${r.prefix}|${r.gateway}|${r.interface_index}|${r.native?.scope ?? ""}`}>{r.prefix} → {r.gateway}<small>{r.interface_alias} · metric {r.interface_id.startsWith('macos:') ? '不适用' : r.route_metric} · {r.store === 'ActiveStore' ? '当前生效' : '持久记录'}{r.native && ` · ${r.native.scope === 'scoped' ? '接口限定' : r.native.scope === 'ambiguous' ? '作用域待确认' : '全局'}`}</small></div>) : <span className="muted">无记录；如读取失败，请以最新刷新为准</span>}</div></div></details>
      </div>)}
    </DialogContent><DialogActions><Button appearance="primary" onClick={onClose}>完成</Button></DialogActions>
  </DialogBody></DialogSurface></Dialog>;
}
