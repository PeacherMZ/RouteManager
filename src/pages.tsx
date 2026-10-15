import { useState } from 'react';
import { Badge, Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input, Select, Textarea } from '@fluentui/react-components';
import type { HostsDocument, Library, OperationResult, RouteConfig, RouteGroup, RouteSnapshot, Settings } from './types';
import { formatTime, stateLabels } from './domain';
import { Empty, Icon, StateBadge } from './components';

export function LibraryPage({ library, snapshot, busy, stale, onEdit, onNew, onApply, onDelete, onGroup, onDeleteGroup, onAddToGroups, onAdoptImport, onExport }: {
  library: Library; snapshot: RouteSnapshot | null; busy: boolean; stale: boolean;
  onEdit: (route: RouteConfig) => void; onNew: () => void; onApply: (ids: string[]) => void;
  onDelete: (ids: string[]) => void; onGroup: (group?: RouteGroup) => void; onDeleteGroup: (id: string) => void;
  onAdoptImport: (text: string) => void; onExport: () => void;
  onAddToGroups: (ids: string[], groups: string[]) => Promise<boolean>;
}) {
  const [groupId, setGroupId] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [targetGroups, setTargetGroups] = useState<string[]>([]);
  const group = library.groups.find(g => g.id === groupId);
  const routes = (group ? group.routes.map(id => library.routes.find(c => c.id === id)!).filter(Boolean) : library.routes)
    .filter(r => [r.name, r.prefix, r.gateway, r.comment].join(' ').toLowerCase().includes(search.toLowerCase()));
  const state = (id: string) => snapshot?.matches.find(m => m.config_id === id)?.state;
  const toggle = (id: string) => setSelected(old => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const selectedIds = library.routes.filter(r => selected.has(r.id)).map(r => r.id);
  return <div className="library-layout">
    <aside className="groups-card">
      <div className="section-heading"><span className="eyebrow">路由分组</span><Button appearance="subtle" size="small" icon={<Icon name="plus" size={16}/>} aria-label="新增分组" onClick={() => onGroup()}/></div>
      <button className={`group-button ${!group ? 'active' : ''}`} onClick={() => setGroupId('')}><span>全部配置</span><span>{library.routes.length}</span></button>
      {library.groups.map(g => {
        const applied = g.routes.filter(id => state(id) === 'active').length;
        return <button className={`group-button ${group?.id === g.id ? 'active' : ''}`} key={g.id} onClick={() => setGroupId(g.id)}>
          <span>{g.name}<small>{stale ? '状态待刷新' : `${applied} / ${g.routes.length} 已生效`}</small></span><span>{g.routes.length}</span>
        </button>;
      })}
      <div className="group-note"><Icon name="shield" size={18}/><p>配置与系统状态独立。删除配置不会删除系统路由。</p></div>
    </aside>
    <section className="table-card library-table">
      <div className="library-heading"><div><h2>{group?.name ?? '全部路由配置'}</h2><p className="muted">{group ? '按成员顺序展示，应用时逐项执行并核验。' : '维护需要管理的路由，随时查看实际生效状态。'}</p></div>
        <div className="button-row">{group && <><Button disabled={busy} onClick={() => onGroup(group)}>编辑分组</Button><Button disabled={busy} onClick={() => onDeleteGroup(group.id)}>删除分组</Button><Button disabled={busy || stale || !group.routes.length} onClick={() => onApply(group.routes)}>应用此组</Button></>}
        <Button appearance="primary" icon={<Icon name="plus" size={17}/>} disabled={busy} onClick={onNew}>新增配置</Button></div>
      </div>
      <div className="table-toolbar"><Input aria-label="搜索配置" className="search-input" contentBefore={<Icon name="search" size={17}/>} placeholder="搜索配置名称、网段或备注" value={search} onChange={(_, d) => setSearch(d.value)}/>
        <Button disabled={busy || stale || !selectedIds.length} onClick={() => onApply(selectedIds)}>应用所选</Button>
        <Button disabled={busy || !selectedIds.length} onClick={() => { setTargetGroups([]); setAdding(true); }}>添加到分组</Button>
        <Button disabled={busy || !selectedIds.length} onClick={() => onDelete(selectedIds)}>删除所选配置</Button>
        <Button disabled={busy} onClick={onExport}>导出 YAML</Button>
        <label className={`file-button ${busy ? 'disabled' : ''}`}>导入 YAML<input aria-label="导入 YAML" type="file" accept=".yaml,.yml" disabled={busy} onChange={async event => {
          const file = event.target.files?.[0]; event.target.value = '';
          if (file) onAdoptImport(await file.text());
        }}/></label>
      </div>
      <div className="table-scroll"><table className="route-table"><thead><tr><th className="check-cell"><Checkbox aria-label="选择所有当前配置" checked={routes.length > 0 && routes.every(r => selected.has(r.id))} onChange={(_, d) => setSelected(old => {
        const next = new Set(old); for (const r of routes) { if (d.checked) next.add(r.id); else next.delete(r.id); } return next;
      })}/></th><th>配置名称</th><th>目标 / 网关</th><th>实际状态</th><th>持久</th><th>备注</th><th/></tr></thead>
        <tbody>{routes.map(route => <tr key={route.id}><td className="check-cell"><Checkbox aria-label={`选择配置 ${route.name}`} checked={selected.has(route.id)} onChange={() => toggle(route.id)}/></td>
          <td><button className="route-link" onClick={() => onEdit(route)}>{route.name}</button><small className="muted">{route.id}</small></td>
          <td className="mono">{route.prefix}<small className="muted">→ {route.gateway}</small></td>
          <td>{stale || !state(route.id) ? <Badge appearance="tint" color="informative">状态未知</Badge> : <StateBadge value={state(route.id)!}/>}</td>
          <td>{route.persistent ? '重启保留' : '临时'}</td><td className="config-comment">{route.comment || '—'}</td>
          <td><Button size="small" appearance="subtle" onClick={() => onEdit(route)}>编辑</Button></td>
        </tr>)}</tbody></table>
        {!routes.length && <Empty title="这里还没有配置" text="新增路由配置，或从当前路由页面将已有路由纳入管理。"/>}
      </div>
      <div className="table-footer"><span>{routes.length} 条配置 · 已选 {selectedIds.length} 条</span><span>保存配置不会自动修改网络</span></div>
    </section>
    {adding && <Dialog open onOpenChange={(_, d) => { if (!d.open && !busy) setAdding(false); }}><DialogSurface><DialogBody>
      <DialogTitle>添加所选配置到分组</DialogTitle><DialogContent>
        <p>已选 {selectedIds.length} 条配置。可选择多个分组；保留原分组，已有成员不重复添加，新成员追加到末尾。</p>
        <div className="member-list">{library.groups.map(g => <Checkbox key={g.id} label={g.name} disabled={busy} checked={targetGroups.includes(g.id)} onChange={(_, d) => setTargetGroups(old => d.checked ? [...old, g.id] : old.filter(id => id !== g.id))}/>)}</div>
        {!library.groups.length && <p>暂无分组，请先点击左侧“新增分组”。</p>}
      </DialogContent><DialogActions><Button disabled={busy} onClick={() => setAdding(false)}>取消</Button><Button appearance="primary" disabled={busy || !targetGroups.length || !selectedIds.length} onClick={async () => {
        if (await onAddToGroups(selectedIds, targetGroups)) { setAdding(false); setSelected(new Set()); }
      }}>确认添加</Button></DialogActions>
    </DialogBody></DialogSurface></Dialog>}
  </div>;
}

export function HistoryPage({ history, onDetail }: { history: OperationResult[]; onDetail: (result: OperationResult) => void }) {
  const [status, setStatus] = useState('');
  const filtered = history.filter(r => !status || r.status === status);
  return <section className="table-card"><div className="table-toolbar"><h2 className="flex-fill">最近操作</h2><Select aria-label="操作结果筛选" value={status} onChange={(_, d) => setStatus(d.value)}><option value="">所有结果</option>{['success','partial','failed','interrupted'].map(s => <option key={s} value={s}>{stateLabels[s]}</option>)}</Select></div>
    <div className="history-list">{filtered.map(result => <button key={result.id} className="history-row" onClick={() => onDetail(result)}>
      <span className={`history-icon ${result.status}`}><Icon name={result.status === 'success' ? 'check' : 'history'}/></span>
      <span className="flex-fill"><strong>{result.items.slice(0, 2).map(i => i.label).join('、')}{result.items.length > 2 ? '…' : ''}</strong><small>{formatTime(result.started_at)} · {result.items.length} 项操作</small></span>
      <StateBadge value={result.status}/><Icon name="arrow" size={17}/>
    </button>)}</div>{!filtered.length && <Empty title="暂无操作记录" text="路由变更会记录执行前后的状态，以及每一项的核验结果。"/>}
  </section>;
}
export function HostsPage({ document, content, onContent, busy, onRead, onSave }: {
  document: HostsDocument | null; content: string; onContent: (text: string) => void; busy: boolean; onRead: () => void; onSave: () => void;
}) {
  const dirty = document !== null && content !== document.content;
  return <section className="table-card hosts-card">
    <div className="library-heading"><div><h2>hosts 文件</h2><p className="muted">{document?.path ?? '读取本机 hosts 后开始编辑'}</p></div><div className="button-row">
      {dirty && <Badge color="warning" appearance="tint">未保存</Badge>}<Button disabled={busy} onClick={onRead}>重新读取</Button><Button appearance="primary" disabled={busy || !dirty} onClick={onSave}>备份并保存</Button>
    </div></div>
    {document ? <><Textarea className="hosts-editor" textarea={{ spellCheck: false, 'aria-label': 'hosts 内容' }} value={content} onChange={(_, d) => onContent(d.value)} resize="none"/>
      <div className="table-footer"><span>{document.encoding} · {document.newline} · {content.split('\n').length} 行</span><span>保存前备份 · 保留原编码与换行 · 检查外部修改</span></div></> : <Empty title="尚未读取 hosts" text="点击“重新读取”加载系统 hosts 文件。"/>}
  </section>;
}
export function SettingsPage({ settings, onChange, busy }: { settings: Settings; onChange: (key: string, value: unknown) => void; busy: boolean }) {
  return <div className="settings-grid"><section className="settings-card"><h2>外观与刷新</h2>
    <Field label="界面主题"><Select value={settings.theme} disabled={busy} onChange={(_, d) => onChange('theme', d.value)}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></Select></Field>
    <Field label="自动刷新间隔" hint="仅在窗口处于前台时刷新；操作结束后立即更新。"><Select value={settings.refresh_seconds} disabled={busy} onChange={(_, d) => onChange('refresh_seconds', Number(d.value))}><option value="0">关闭自动刷新</option><option value="5">5 秒</option><option value="10">10 秒</option><option value="30">30 秒</option></Select></Field>
  </section><section className="settings-card"><h2>本地数据</h2><dl><dt>存储位置</dt><dd className="mono path">{settings.data_dir}</dd><dt>备份目录</dt><dd className="mono path">{settings.backups_dir}</dd><dt>导出目录</dt><dd className="mono path">{settings.exports_dir}</dd><dt>数据库</dt><dd>SQLite · routes.db</dd><dt>配置兼容</dt><dd>兼容旧版 YAML 导入 / v3 YAML 导出</dd><dt>版本</dt><dd>{settings.version}</dd></dl><p className="muted">升级和卸载保留用户数据；程序安装目录与数据目录相互独立。</p></section>
    <section className="settings-card full"><h2>管理范围</h2><div className="scope-grid"><div><Icon name="shield"/><strong>管理员权限</strong><p>{settings.platform.privilege === 'startup' ? '启动时提权，数据仍属于启动用户。' : '系统修改时请求管理员授权，助手执行后退出。'}</p></div><div><Icon name="routes"/><strong>IPv4 管理 · IPv6 只读</strong><p>{settings.platform.os === 'macos' ? '管理当前网络位置；持久化由系统网络服务提供。' : '管理本机默认网络隔离区的路由。'}</p></div><div><Icon name="library"/><strong>准确匹配，明确归属</strong><p>命中配置库表示受管理，创建记录独立展示。</p></div></div></section>
  </div>;
}
