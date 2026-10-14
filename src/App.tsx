import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, FluentProvider,
  OverlayDrawer, DrawerHeader, DrawerHeaderTitle, DrawerBody, Spinner, webDarkTheme, webLightTheme } from '@fluentui/react-components';
import { api, demo, desktop } from './api';
import { activeRecord, formatTime, fromRoute, ownerLabels, persistence } from './domain';
import { GroupEditor, Icon, PlanDialog, ResultDialog, RouteEditor, StateBadge } from './components';
import { RouteTable } from './RouteTable';
import { HistoryPage, HostsPage, LibraryPage, SettingsPage } from './pages';
import type { HostsDocument, Library, OperationPlan, OperationResult, PlanRequest, RouteConfig, RouteGroup, RouteSnapshot, Settings } from './types';
import logo from './logo.svg';

type Page = 'routes' | 'library' | 'history' | 'hosts' | 'settings';
const nav: { id: Page; title: string; description: string }[] = [
  { id: 'routes', title: '当前路由', description: '查看实际网络状态，精确管理每一条路由。' },
  { id: 'library', title: '配置库与分组', description: '让常用路由有序可用，清楚掌握每项配置的生效状态。' },
  { id: 'history', title: '操作记录', description: '每一次变更，都有执行结果与核验依据。' },
  { id: 'hosts', title: 'hosts 编辑', description: '管理本机域名映射，保存前自动备份。' },
  { id: 'settings', title: '设置', description: '调整显示偏好，了解本地数据与管理范围。' },
];
const defaultSettings: Settings = { theme: 'system', refresh_seconds: 5, data_dir: '加载中…', version: '2.0.0' };
export function App() {
  const [page, setPage] = useState<Page>('routes');
  const [settings, setSettings] = useState(defaultSettings);
  const [systemDark, setSystemDark] = useState(matchMedia('(prefers-color-scheme: dark)').matches);
  const [snapshot, setSnapshot] = useState<RouteSnapshot | null>(null);
  const [library, setLibrary] = useState<Library>({ routes: [], groups: [] });
  const [history, setHistory] = useState<OperationResult[]>([]);
  const [snapshotError, setSnapshotError] = useState('');
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshPromise = useRef<Promise<void> | null>(null);
  const libraryRevision = useRef(0);
  const routeRevision = useRef(0);
  const busyRef = useRef(false);
  const [selected, setSelected] = useState(new Set<string>());
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ draft: RouteConfig; system: boolean; sourceKey?: string } | null>(null);
  const [groupEditor, setGroupEditor] = useState<RouteGroup | null>(null);
  const [plan, setPlan] = useState<OperationPlan | null>(null);
  const [result, setResult] = useState<OperationResult | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; text: string; action: () => Promise<boolean> } | null>(null);
  const [hosts, setHosts] = useState<HostsDocument | null>(null);
  const [hostsContent, setHostsContent] = useState('');
  const hostsDirty = hosts !== null && hostsContent !== hosts.content;
  const closeState = useRef({ busy: false, hostsDirty: false });
  closeState.current = { busy, hostsDirty };
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && systemDark);
  const theme = { ...(dark ? webDarkTheme : webLightTheme),
    colorBrandBackground: dark ? '#359d87' : '#12675d', colorBrandBackgroundHover: dark ? '#44ae96' : '#0c574e',
    colorBrandBackgroundPressed: '#094c44', colorBrandForeground1: dark ? '#71d5b9' : '#12675d',
    colorBrandForeground2: dark ? '#8be1c8' : '#12675d', colorBrandStroke1: dark ? '#71d5b9' : '#12675d',
    colorCompoundBrandBackground: '#12675d', colorCompoundBrandStroke: '#12675d',
  };
  const refresh = useCallback((metadata = false, afterCurrent = false): Promise<void> => {
    if (refreshPromise.current) return afterCurrent ? refreshPromise.current.then(() => refresh(metadata)) : refreshPromise.current;
    setRefreshing(true);
    const revision = libraryRevision.current;
    const routesRevision = routeRevision.current;
    const snapshotRead = api.snapshot().then(next => {
      if (routesRevision !== routeRevision.current) return;
      setSnapshot(next); setSnapshotError('');
      setSelected(old => new Set([...old].filter(key => next.routes.some(row => row.key === key))));
    }).catch(error => { if (routesRevision === routeRevision.current) setSnapshotError(String(error)); });
    const reads: Promise<unknown>[] = [snapshotRead];
    if (metadata) reads.push(
      api.library().then(next => { if (revision === libraryRevision.current) setLibrary(next); }).catch(error => setNotice({ text: '配置库读取失败：' + String(error), error: true })),
      api.history().then(setHistory),
    );
    const pending = Promise.allSettled(reads).then(() => { refreshPromise.current = null; setRefreshing(false); });
    refreshPromise.current = pending;
    return pending;
  }, []);
  useEffect(() => {
    void refresh(true);
    void api.settings().then(setSettings).catch(error => setNotice({ text: String(error), error: true }));
    const media = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemDark(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [refresh]);
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible' && document.hasFocus() && !busyRef.current && !plan && !editor && !groupEditor && !confirm) void refresh(); };
    const timer = settings.refresh_seconds ? window.setInterval(tick, settings.refresh_seconds * 1000) : undefined;
    window.addEventListener('focus', tick); document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); window.removeEventListener('focus', tick); document.removeEventListener('visibilitychange', tick); };
  }, [refresh, settings.refresh_seconds, plan, editor, groupEditor, confirm]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (closeState.current.hostsDirty || closeState.current.busy) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    let unlisten: (() => void) | undefined;
    let disposed = false;
    if (desktop) void import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
      const stop = await getCurrentWindow().onCloseRequested(event => {
        if (closeState.current.busy) { event.preventDefault(); setNotice({ text: '操作尚未完成，请等待核验结束后再退出。', error: true }); }
        else if (closeState.current.hostsDirty) {
          event.preventDefault();
          setConfirm({ title: '退出并放弃 hosts 修改？', text: '当前 hosts 内容尚未保存。', action: async () => { await getCurrentWindow().destroy(); return true; } });
        }
      });
      if (disposed) stop(); else unlisten = stop;
    }).catch(error => setNotice({ text: '窗口关闭保护初始化失败：' + String(error), error: true }));
    return () => { disposed = true; unlisten?.(); window.removeEventListener('beforeunload', beforeUnload); };
  }, []);
  const task = async (work: () => Promise<void>): Promise<boolean> => {
    if (busyRef.current) return false;
    busyRef.current = true; setBusy(true); setNotice(null);
    try { await work(); return true; }
    catch (error) { setNotice({ text: String(error), error: true }); return false; }
    finally { busyRef.current = false; setBusy(false); }
  };
  const preview = (request: PlanRequest) => task(async () => { setPlan(await api.preview(request)); });
  const saveLibrary = (next: Library) => task(async () => {
    const routesChanged = JSON.stringify(next.routes) !== JSON.stringify(library.routes);
    libraryRevision.current += 1;
    if (routesChanged) routeRevision.current += 1;
    setLibrary(await api.saveLibrary(next));
    if (routesChanged) {
      setSnapshotError('配置已更新，正在重新核对管理归属。');
      void refresh(false, true);
    }
  });
  const newConfig = (): RouteConfig => ({ id: crypto.randomUUID(), name: '', prefix: '', gateway: '', interface_guid: null, metric: null, persistent: true, comment: '' });
  const currentNav = nav.find(n => n.id === page)!;
  const detail = snapshot?.routes.find(r => r.key === detailKey);
  const stale = !snapshot || !!snapshotError;
  const readHosts = () => task(async () => { const next = await api.readHosts(); setHosts(next); setHostsContent(next.content); });
  const navigate = (target: Page) => {
    if (hostsDirty && page === 'hosts' && target !== 'hosts') {
      setConfirm({ title: '保留未保存的 hosts 修改？', text: '内容会暂存在编辑器中，返回 hosts 页面可以继续编辑。', action: async () => { setPage(target); return true; } });
    } else setPage(target);
    if (target === 'hosts' && !hosts) void readHosts();
  };
  const selectedRows = snapshot?.routes.filter(r => selected.has(r.key)) ?? [];
  const active = snapshot?.routes.filter(r => r.records.some(x => x.store === 'ActiveStore')).length ?? 0;
  const managed = snapshot?.routes.filter(r => r.ownership === 'managed').length ?? 0;
  const inactive = snapshot?.matches.filter(m => m.state !== 'active').length ?? 0;

  return <FluentProvider theme={theme} className="app-provider" data-theme={dark ? 'dark' : 'light'}>
    <div className="app-shell">
      <aside className="sidebar"><div className="brand"><img src={logo} alt=""/><div><strong>路由管理器</strong><span>ROUTE MANAGER</span></div></div>
        <div className="workspace-label">本机网络</div>
        <nav aria-label="主导航">{nav.map(item => <button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => navigate(item.id)}>
          <Icon name={item.id}/><span>{item.title}</span>{item.id === 'library' && <span className="nav-count">{library.routes.length}</span>}
        </button>)}</nav>
        <div className="sidebar-bottom"><div className="local-indicator"><span/>本地运行 · 数据不上传</div><div className="permission"><Icon name="shield" size={17}/>{demo ? '演示数据 · 不修改系统' : desktop ? '管理员模式' : '浏览器预览 · 不连接系统'}</div><small>版本 {settings.version} · Windows</small></div>
      </aside>
      <main className="main">
        <header className="topbar"><div className="breadcrumb">本机网络<span>/</span>{currentNav.title}</div><div className="topbar-right"><span className={`status-dot ${stale ? 'warning' : ''}`}/>{stale ? '状态待同步' : '已连接本机'}<span className="topbar-divider"/><span>IPv4 管理</span><Badge appearance="outline" color="informative">IPv6 只读</Badge></div></header>
        <div className="content">
          <div className="page-heading"><div><div className="eyebrow">{page === 'routes' ? 'NETWORK OVERVIEW' : 'WORKSPACE'}</div><h1>{currentNav.title}</h1><p>{currentNav.description}</p></div>
            <div className="button-row"><Button icon={<Icon name="refresh" size={17}/>} disabled={refreshing || busy} onClick={() => void refresh(true)}>{refreshing ? '刷新中…' : '刷新'}</Button>
              {page === 'routes' && <Button appearance="primary" disabled={busy || stale} icon={<Icon name="plus" size={18}/>} onClick={() => setEditor({ draft: newConfig(), system: true })}>新增路由</Button>}
            </div></div>
          {demo && <div className="demo-banner">演示模式 · 以下为模拟路由，所有修改仅在当前浏览器内存中生效。</div>}
          {notice && <div role={notice.error ? 'alert' : 'status'} className={notice.error ? 'error-banner' : 'success-banner'}><span>{notice.text}</span><Button appearance="subtle" size="small" aria-label="关闭提示" icon={<Icon name="close" size={16}/>} onClick={() => setNotice(null)}/></div>}
          {snapshotError && <div role="alert" className="error-banner"><div><strong>{snapshot ? '路由数据已过期' : '无法读取系统路由'}</strong><p>{snapshotError}</p>{snapshot && <small>当前仍显示 {formatTime(snapshot.captured_at)} 的数据；系统变更操作暂停。</small>}</div></div>}
          {page === 'routes' && <>
            <div className="stats-grid">
              <div className="stat-card"><div><span>当前生效路由</span><strong>{snapshot ? active : '—'}<small>条</small></strong><p>IPv4 与 IPv6 活动记录</p></div><div className="stat-icon"><Icon name="routes" size={24}/></div></div>
              <div className="stat-card managed"><div><span>本管理器管理</span><strong>{snapshot ? managed : '—'}<small>条</small></strong><p>与配置库准确匹配</p></div><div className="stat-icon"><Icon name="shield" size={24}/></div></div>
              <div className="stat-card"><div><span>配置待处理</span><strong>{snapshot ? inactive : '—'}<small>项</small></strong><p>未生效、属性不同或接口待确认</p></div><div className="stat-icon warm"><Icon name="library" size={24}/></div></div>
            </div>
            <div className="section-heading route-actions"><div><h2>系统路由表</h2><span className="muted">最后同步 {snapshot ? new Date(snapshot.captured_at).toLocaleTimeString('zh-CN', { hour12: false }) : '—'} {refreshing && <Spinner size="extra-tiny"/>}</span></div>
              <div className="button-row"><Button disabled={busy || stale || selected.size !== 1} onClick={() => setEditor({ draft: fromRoute(selectedRows[0], library), system: true, sourceKey: selectedRows[0].key })}>修改所选</Button>
                <Button disabled={busy || stale || !selected.size} onClick={() => {
                  const next = { ...library, routes: [...library.routes] };
                  for (const row of selectedRows) if (!row.config_ids.length) next.routes.push(fromRoute(row, library));
                  void saveLibrary(next);
                }}>纳入管理</Button>
                <Button disabled={busy || stale || !selected.size} onClick={() => void preview({ action: 'remove', route_keys: [...selected] })}>从系统移除</Button>
                <Button className="danger-outline" disabled={busy || stale || !managed} onClick={() => void preview({ action: 'clear_managed' })}>清除受管理路由</Button></div>
            </div>
            <RouteTable rows={snapshot?.routes ?? []} library={library} selected={selected} onSelected={setSelected} onDetail={row => setDetailKey(row.key)}/>
            <p className="page-footnote"><Icon name="shield" size={14}/>清除受管理路由会保留配置库，方便再次应用。其他路由保持当前状态。</p>
          </>}
          {page === 'library' && <LibraryPage library={library} snapshot={snapshot} stale={stale} busy={busy}
            onEdit={draft => setEditor({ draft, system: false })} onNew={() => setEditor({ draft: newConfig(), system: false })}
            onApply={ids => void preview({ action: 'apply', config_ids: ids })}
            onDelete={ids => setConfirm({ title: `删除 ${ids.length} 条配置？`, text: '只从配置库及分组中移除，系统中的实际路由不会被删除。', action: () => saveLibrary({ routes: library.routes.filter(r => !ids.includes(r.id)), groups: library.groups.map(g => ({ ...g, routes: g.routes.filter(id => !ids.includes(id)) })) }) })}
            onGroup={group => setGroupEditor(group ?? { id: crypto.randomUUID(), name: '', routes: [] })}
            onAddToGroups={(ids, groups) => saveLibrary({ ...library, groups: library.groups.map(g => groups.includes(g.id) ? { ...g, routes: [...new Set([...g.routes, ...ids])] } : g) })}
            onDeleteGroup={id => setConfirm({ title: '删除此分组？', text: '保留路由配置和系统路由。', action: () => saveLibrary({ ...library, groups: library.groups.filter(g => g.id !== id) }) })}
            onAdoptImport={text => setConfirm({ title: '导入并替换配置库？', text: '导入前自动备份当前数据库。仅替换配置和分组，不修改系统路由。', action: () => task(async () => { libraryRevision.current += 1; routeRevision.current += 1; setLibrary(await api.importYaml(text)); setSnapshotError('配置已导入，正在重新核对管理归属。'); void refresh(false, true); }) })}
            onExport={() => void task(async () => { const path = await api.exportYaml(); setNotice({ text: `已导出：${path}`, error: false }); })}/>}
          {page === 'history' && <HistoryPage history={history} onDetail={setResult}/>}
          {page === 'hosts' && <HostsPage document={hosts} content={hostsContent} onContent={setHostsContent} busy={busy}
            onRead={() => { if (hostsDirty) setConfirm({ title: '放弃未保存修改并重新读取？', text: '编辑器内容将替换为系统中的 hosts 文件。', action: readHosts }); else void readHosts(); }}
            onSave={() => void task(async () => { const next = await api.saveHosts(hostsContent, hosts!.fingerprint); setHosts(next); setHostsContent(next.content); setNotice({ text: 'hosts 已备份并保存。', error: false }); })}/>}
          {page === 'settings' && <SettingsPage settings={settings} busy={busy} onChange={(key, value) => void task(async () => { await api.saveSetting(key, value); setSettings(await api.settings()); })}/>}
        </div>
      </main>
    </div>
    {busy && !plan && <div className="busy-indicator" role="status"><Spinner size="tiny"/>正在处理…</div>}
    <OverlayDrawer position="end" size="medium" open={!!detailKey} onOpenChange={(_, d) => { if (!d.open) setDetailKey(null); }}>
      <DrawerHeader><DrawerHeaderTitle action={<Button aria-label="关闭详情" appearance="subtle" icon={<Icon name="close"/>} onClick={() => setDetailKey(null)}/>}>路由详情</DrawerHeaderTitle></DrawerHeader>
      <DrawerBody>{detail ? <>
        <h2 className="mono">{activeRecord(detail).prefix}</h2><div className="button-row"><Badge appearance="tint" color={detail.ownership === 'managed' ? 'success' : 'informative'}>{ownerLabels[detail.ownership]}</Badge><Badge appearance="outline">{persistence(detail)}</Badge></div>
        <dl className="detail-list"><dt>网关</dt><dd className="mono">{activeRecord(detail).gateway}</dd><dt>网络接口</dt><dd>{activeRecord(detail).interface_alias} · if {activeRecord(detail).interface_index}</dd><dt>接口 GUID</dt><dd className="mono path">{activeRecord(detail).interface_guid || '系统未提供'}</dd><dt>创建记录</dt><dd>{detail.created_by_app ? '操作日志记录本程序曾创建同标识路由' : '没有本程序创建的历史证据'}</dd><dt>匹配配置</dt><dd>{detail.config_ids.map(id => library.routes.find(c => c.id === id)?.name).join('、') || '无'}</dd></dl>
        {detail.ambiguous_config_ids.length > 0 && <div className="warning-banner">配置匹配到多个接口，需要先绑定接口后才能批量清除。</div>}
        <h3>活动与持久记录</h3>{detail.records.map(record => <div className="record-card" key={record.store}><strong>{record.store === 'ActiveStore' ? '当前生效' : '重启后保留'}</strong><p>路由 metric {record.route_metric} + 接口 metric {record.interface_metric} = {record.route_metric + record.interface_metric}</p><span className="muted">协议：{record.protocol || '系统未提供'} · 原始接口索引 {record.interface_index}</span>{record.associated_interface_guid && <p className="muted">历史持久记录未绑定接口，已按唯一活动路由关联；删除时仍定位原始记录。</p>}</div>)}
        <h3>相关操作</h3>{history.filter(h => h.items.some(i => [...i.before, ...i.after].some(r => r.prefix === activeRecord(detail).prefix && r.gateway === activeRecord(detail).gateway && r.interface_guid === activeRecord(detail).interface_guid))).slice(0, 10).map(h => <button className="related-operation" key={h.id} onClick={() => setResult(h)}>{formatTime(h.started_at)}<StateBadge value={h.status}/></button>)}
        <p className="muted">管理归属来自配置匹配，系统协议和创建日志提供独立的来源线索。</p>
      </> : <p>该路由已不在最新快照中。</p>}</DrawerBody>
    </OverlayDrawer>
    {editor && <RouteEditor initial={editor.draft} interfaces={snapshot?.interfaces ?? []} system={editor.system} busy={busy} onClose={() => setEditor(null)} onSave={(draft, save) => {
      if (editor.system) return preview({ action: 'upsert', draft, save_config: save, source_key: editor.sourceKey });
      const routes = library.routes.some(r => r.id === draft.id) ? library.routes.map(r => r.id === draft.id ? draft : r) : [...library.routes, draft];
      return saveLibrary({ ...library, routes });
    }}/>}
    {groupEditor && <GroupEditor initial={groupEditor} library={library} busy={busy} onClose={() => setGroupEditor(null)} onSave={group => saveLibrary({ ...library,
      groups: library.groups.some(g => g.id === group.id) ? library.groups.map(g => g.id === group.id ? group : g) : [...library.groups, group] })}/>}
    {plan && <PlanDialog plan={plan} busy={busy} onClose={() => setPlan(null)} onConfirm={() => void task(async () => { try { const next = await api.execute(plan.id); setResult(next); } finally { setPlan(null); libraryRevision.current += 1; routeRevision.current += 1; await refresh(true, true); } })}/>}
    {result && <ResultDialog result={result} onClose={() => setResult(null)}/>}
    {confirm && <Dialog open onOpenChange={(_, d) => { if (!d.open && !busy) setConfirm(null); }}><DialogSurface><DialogBody><DialogTitle>{confirm.title}</DialogTitle><DialogContent>{confirm.text}</DialogContent><DialogActions><Button disabled={busy} onClick={() => setConfirm(null)}>取消</Button><Button appearance="primary" disabled={busy} onClick={async () => { try { if (await confirm.action()) setConfirm(null); } catch (error) { setNotice({ text: String(error), error: true }); } }}>确认</Button></DialogActions></DialogBody></DialogSurface></Dialog>}
  </FluentProvider>;
}
