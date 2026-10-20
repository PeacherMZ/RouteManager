import { useState } from 'react';
import { Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input, Select, Switch, Textarea } from '@fluentui/react-components';
import { patchConfigs, validateConfigs, type ConfigPatch } from './domain';
import { GatewayField, type GatewaySource } from './GatewayField';
import { usePlatform } from './platform';
import type { Library } from './types';

export function BatchConfigEditor({ ids, library, busy, onClose, onSave, ...gateways }: GatewaySource & {
  ids: string[]; library: Library; busy: boolean; onClose: () => void; onSave: (patch: ConfigPatch) => Promise<boolean>;
}) {
  const platform = usePlatform();
  const routes = library.routes.filter(route => ids.includes(route.id));
  const [enabled, setEnabled] = useState<Set<keyof ConfigPatch>>(new Set());
  const [values, setValues] = useState(() => ({ ...routes[0], metric: platform.metric ? routes[0]?.metric ?? null : null }));
  const [error, setError] = useState('');
  const patch: ConfigPatch = Object.fromEntries([...enabled].map(key => [key, values[key]]));
  const next = patchConfigs(library.routes, ids, patch);
  const changed = next.filter(route => ids.includes(route.id) && JSON.stringify(route) !== JSON.stringify(library.routes.find(original => original.id === route.id))).length;
  const interfaces = gateways.snapshot?.interfaces ?? [];
  const toggle = (key: keyof ConfigPatch, label: string, disabled = false) => <Checkbox label={`修改${label}`} checked={enabled.has(key)} disabled={busy || disabled}
    onChange={(_, data) => { setError(''); setEnabled(old => { const result = new Set(old); if (data.checked) result.add(key); else result.delete(key); return result; }); }}/>;
  const submit = async () => {
    const invalid = validateConfigs(next);
    if (invalid) { setError(invalid); return; }
    if ((enabled.has('interface_id') || enabled.has('persistent')) && next.some(route => ids.includes(route.id) && route.persistent && route.interface_id?.startsWith('macos:') && route.interface_id.endsWith(':-'))) {
      setError('所选接口没有唯一网络服务，请同时将持久路由修改为临时路由。'); return;
    }
    setError('');
    if (await onSave(patch)) onClose();
    else setError('保存失败，修改尚未保存。请重试或取消后查看页面错误提示。');
  };
  return <Dialog open onOpenChange={(_, data) => { if (!data.open && !busy) onClose(); }}><DialogSurface className="editor-dialog batch-editor"><DialogBody>
    <DialogTitle>批量修改配置</DialogTitle><DialogContent>
      <p className="muted">已选 {routes.length} 条配置。表单初始值来自第一条配置，仅用勾选的字段覆盖所选项；保存后需应用配置才会改变系统路由。</p>
      <details className="batch-targets"><summary>查看所选配置（{routes.length}）</summary><ul>{routes.map(route => <li key={route.id}>{route.name}<span className="mono">{route.prefix} → {route.gateway}</span></li>)}</ul></details>
      <div className="form-grid batch-fields">
        <div>{toggle('prefix', '目标网段')}<Field label="目标网段 / 前缀长度"><Input disabled={busy || !enabled.has('prefix')} value={values.prefix} onChange={(_, data) => setValues(old => ({ ...old, prefix: data.value }))}/></Field></div>
        <div>{toggle('gateway', '网关')}<GatewayField {...gateways} disabled={busy || !enabled.has('gateway')} value={values.gateway} onChange={gateway => setValues(old => ({ ...old, gateway }))}/></div>
        <div className="full">{toggle('interface_id', '网络接口')}<Field label="网络接口" hint="选择网关不会自动更改接口；自动匹配必须唯一。">
          <Select disabled={busy || !enabled.has('interface_id')} value={values.interface_id ?? ''} onChange={(_, data) => setValues(old => ({ ...old, interface_id: data.value || null }))}>
            <option value="">自动匹配（必须唯一）</option>
            {values.interface_id && !interfaces.some(i => i.guid === values.interface_id) && <option value={values.interface_id}>已保存接口（当前不可用）</option>}
            {interfaces.map(i => <option key={i.guid} value={i.guid}>{i.alias} · {i.addresses.join(', ') || '无 IPv4'} {i.status !== 'Up' ? '· 未连接' : ''}</option>)}
          </Select>
        </Field></div>
        <div>{toggle('metric', '路由 metric', !platform.metric)}<Field label="路由 metric" hint={platform.metric ? '勾选后留空，将清除配置中的指定 metric。' : 'macOS 不适用；保留原配置值。'}>
          <Input type="number" min={0} max={65535} disabled={busy || !platform.metric || !enabled.has('metric')} value={values.metric === null ? '' : String(values.metric)} onChange={(_, data) => setValues(old => ({ ...old, metric: data.value === '' ? null : Number(data.value) }))}/>
        </Field></div>
        <div>{toggle('persistent', '持久路由', !platform.persistent_routes)}<Field label="持久路由"><Switch disabled={busy || !enabled.has('persistent')} label="重启后保留" checked={values.persistent} onChange={(_, data) => setValues(old => ({ ...old, persistent: data.checked }))}/></Field></div>
        {platform.os === 'macos' && <div className="full">{toggle('scope', '路由作用域')}<Field label="路由作用域" hint="仅适用于 macOS 临时路由；持久路由请先取消重启保留。"><Select disabled={busy || !enabled.has('scope')} value={values.scope ?? ''} onChange={(_, data) => setValues(old => ({ ...old, scope: (data.value || null) as 'scoped' | 'unscoped' | null }))}>
          <option value="">不指定</option><option value="unscoped">全局</option><option value="scoped">接口限定</option>
        </Select></Field></div>}
        <div className="full">{toggle('comment', '备注')}<Field label="备注" hint="勾选后留空，将清除所选配置的备注。"><Textarea resize="vertical" disabled={busy || !enabled.has('comment')} value={values.comment} onChange={(_, data) => setValues(old => ({ ...old, comment: data.value }))}/></Field></div>
      </div>
      {error && <p role="alert" className="error-text">{error}</p>}
      <p className="muted" role="status">已勾选 {enabled.size} 个字段，将更新 {changed} 条配置。</p>
    </DialogContent><DialogActions><Button disabled={busy} onClick={onClose}>取消</Button><Button appearance="primary" disabled={busy || !changed || !enabled.size} onClick={() => void submit()}>保存批量修改</Button></DialogActions>
  </DialogBody></DialogSurface></Dialog>;
}
