import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {createPortal}from'react-dom';
import type { ReactNode } from 'react';
import type { ClientPluginContext, UiRuntime, ViewProps } from '@aork/sdk/client';
import { defaultPreferences, preferencesSchema, readPreferences, unreadPageSchema, type WorkbenchPreferences, type UnreadPage, type ReadTrackerContext, type WorkbenchLayoutContext } from '@aork/contracts/workbench';
import { pendingIndexSchema, type PendingIndex } from '@aork/contracts/interaction';
import { sessionReferencesSchema } from '@aork/contracts/session';
import { readWorkbenchSelection, withWorkbenchSelection } from '@aork/contracts/workspace';
import styles from './workbench.module.css';
import {observeReadableContent,type ReadableContentObserver}from'./read-visibility.js';
function useHash() { const [value, setValue] = useState(() => location.hash); useEffect(() => { const changed = () => setValue(location.hash); addEventListener('hashchange', changed); return () => removeEventListener('hashchange', changed); }, []); return value; }
function useSaved<T>(runtime: UiRuntime, name: string, parse: (value: unknown) => T, parameters: Record<string, string> = {}) {
    const [state, setState] = useState<{ key: string; value: T | undefined; error: string }>();
    const key = JSON.stringify([name, parameters]);
    useEffect(() => {
        let live = true;
        const stop = runtime.observeSnapshot<unknown>(name, JSON.parse(key)[1], {
            next(data) {
                if (live) setState({ key, value: parse(data), error: '' });
            },
            error(failure) {
                if (live) setState(previous => ({ key, value: previous?.key === key ? previous.value : undefined, error: failure.message }));
            },
        }, { owners: [name.split('.')[0]!] });
        return () => { live = false; void stop(); };
    }, [runtime, name, key, parse]);
    return state?.key === key ? state : { value: undefined, error: '' };
}
function go(page: string) {
    const selection = withWorkbenchSelection(location.hash, {
        sessionId: null,
        creatingSession: false,
        ...(page === 'workspaces' ? { workspaceId: null, directory: null, file: null, line: null } : {}),
    });
    const values = new URLSearchParams(selection);
    values.set('page', page);
    location.hash = values.toString();
}
type LayoutContext = WorkbenchLayoutContext;
function layoutContext(context: unknown): LayoutContext | undefined { return context && typeof context === 'object' && 'preferences' in context && preferencesSchema.safeParse(context.preferences).success && 'save' in context && typeof context.save === 'function' && 'narrow' in context && typeof context.narrow === 'boolean' ? context as LayoutContext : undefined; }
function useNarrow(query = '(max-width:799px)') { const [value, setValue] = useState(() => matchMedia(query).matches); useEffect(() => { const media = matchMedia(query); const changed = () => setValue(media.matches); media.addEventListener('change', changed); return () => media.removeEventListener('change', changed); }, []); return value; }
function useDrawer(ref: React.RefObject<HTMLElement | null>, open: boolean, close: () => void) {
    useEffect(() => { if (!open)
        return; const before = document.activeElement as HTMLElement | null; const node = ref.current; if (!node)
        return; const focusable = () => [...node.querySelectorAll<HTMLElement>('button,a,input,select,textarea,[tabindex="0"]')].filter(item => !item.hasAttribute('disabled') && !item.closest('[hidden]')); focusable()[0]?.focus(); const key = (event: KeyboardEvent) => { if (event.key === 'Escape') {
        event.preventDefault();
        close();
    } if (event.key === 'Tab') {
        const items = focusable();
        if (!items.length) {
            event.preventDefault();
            return;
        }
        const first = items[0], last = items.at(-1);
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
        }
        else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
        }
    } }; node.addEventListener('keydown', key); return () => { node.removeEventListener('keydown', key); if (before?.isConnected)
        before.focus(); }; }, [open]);
}
const light = { '--aork-background': '#f9fafb', '--aork-surface': '#ffffff', '--aork-text': '#0f1115', '--aork-muted': '#60646c', '--aork-border': '#e5e7eb', '--aork-accent': '#59759c', '--aork-user': '#edf3fe', '--aork-composer': '#ffffff' };
const dark = { '--aork-background': '#202020', '--aork-surface': '#181818', '--aork-text': '#e9e9e9', '--aork-muted': '#acacac', '--aork-border': '#343434', '--aork-accent': '#8cbaff', '--aork-user': '#1c467f', '--aork-composer': '#303030' };
function Layout({ runtime }: ViewProps) {
    const saved = useSaved(runtime, 'workbench.preferences', readPreferences);
    const [preferences, setPreferences] = useState(defaultPreferences);
    const [error, setError] = useState('');
    const narrow = useNarrow();
    const inspectorOverlay = useNarrow('(max-width:1149px)');
    const [mobileSurface, setMobileSurface] = useState<'sidebar' | 'inspector' | null>(null);
    const latest = useRef(preferences);
    latest.current = preferences;
    const rail = useRef<HTMLElement>(null);
    const inspector = useRef<HTMLElement>(null);
    const hash = useHash();
    const selection = readWorkbenchSelection(hash);
    useEffect(() => { if (saved.value)
        setPreferences(saved.value); }, [saved.value]);
    function save(update: Partial<WorkbenchPreferences>) { if (narrow && 'sidebarOpen' in update || inspectorOverlay && 'inspectorOpen' in update) {
        setMobileSurface(update.sidebarOpen ? 'sidebar' : update.inspectorOpen ? 'inspector' : null);
        update = { ...update };
        if (narrow)
            delete update.sidebarOpen;
        if (inspectorOverlay)
            delete update.inspectorOpen;
        if (!Object.keys(update).length)
            return;
    } const next = { ...latest.current, ...update }; latest.current = next; setPreferences(next); void runtime.command('workbench.savePreferences', next, crypto.randomUUID()).then(() => setError('')).catch(failure => setError(failure.message)); }
    const effective = { ...preferences, sidebarOpen: narrow ? mobileSurface === 'sidebar' : preferences.sidebarOpen, inspectorOpen: inspectorOverlay ? mobileSurface === 'inspector' : preferences.inspectorOpen };
    const context: LayoutContext = { preferences: effective, save, narrow, inspectorOverlay };
    useEffect(() => { if(runtime.bootstrap.ui.providers['aork.ui.theme@1']!=='workbench:theme')return;const media = matchMedia('(prefers-color-scheme:dark)'); const apply = () => { const selected = preferences.theme === 'system' ? (media.matches ? 'dark' : 'light') : preferences.theme; document.documentElement.dataset.aorkTheme = selected; document.documentElement.style.colorScheme = selected; for (const [token, value] of Object.entries(selected === 'dark' ? dark : light))
        document.documentElement.style.setProperty(token, value); }; apply(); media.addEventListener('change', apply); return () => media.removeEventListener('change', apply); }, [preferences.theme]);
    const sidebarVisible = effective.sidebarOpen;
    // The right region belongs to whatever the selected inspector provider shows; Files is
    // only the default section inside it. Both region switches keep their own state.
    const inspectorVisible = Boolean(selection.workspaceId || selection.sessionId) && effective.inspectorOpen;
    useEffect(() => { setMobileSurface(null); }, [selection.workspaceId, selection.sessionId, new URLSearchParams(hash.slice(1)).get('page')]);
    useDrawer(rail, narrow && sidebarVisible, () => save({ sidebarOpen: false }));
    useDrawer(inspector, inspectorOverlay && inspectorVisible, () => save({ inspectorOpen: false }));
    return <div className={styles.layout} data-sidebar={sidebarVisible ? 'open' : 'closed'} data-inspector={inspectorVisible ? 'open' : 'closed'} data-wide={preferences.inspectorWide}>
  <aside ref={rail} data-region="left" hidden={!sidebarVisible} className={styles.rail} inert={inspectorOverlay && inspectorVisible || undefined} aria-label="工作台侧栏" role={narrow ? 'dialog' : undefined} aria-modal={narrow ? true : undefined}>{runtime.renderView('aork.workbench.sidebar@1', context)}</aside>
  <div className={styles.center} data-region="center" inert={narrow && sidebarVisible || undefined}>
   <header className={styles.header} inert={inspectorOverlay && inspectorVisible || undefined}>{runtime.renderView('aork.workbench.header-view@1', context)}</header>
   <div className={styles.columns}>
    <div className={styles.conversation} inert={inspectorOverlay && inspectorVisible || undefined}>
     {runtime.renderExtensions('aork.workbench.conversation@1', context)}
     <main className={styles.content}>{runtime.renderView('aork.workbench.main@1', context)}</main>
    </div>
    <aside ref={inspector} data-region="right" hidden={!inspectorVisible} className={styles.inspector} aria-label="右侧栏" role={inspectorOverlay ? 'dialog' : 'complementary'} aria-modal={inspectorOverlay ? true : undefined}>
     {/* Region chrome belongs to the layout so replacing the content provider never
         removes close/width. The provider is the region's content container. */}
     <div className={styles.panelHeader}><strong>右侧栏</strong>{!inspectorOverlay && <button onClick={() => save({ inspectorWide: !preferences.inspectorWide })} aria-label="切换右侧栏宽度" aria-pressed={preferences.inspectorWide}>↔</button>}<button onClick={() => save({ inspectorOpen: false })} aria-label="关闭右侧栏">×</button></div>
     <div className={styles.inspectorBody}>{runtime.renderView('aork.workbench.inspector@1', context)}</div>
    </aside>
   </div>
  </div>
  {(error || saved.error) && <p className={styles.preferenceError} role="alert">布局偏好同步失败：{error || saved.error}</p>}
 </div>;
}
/** Default right-region content: installed sections only. The layout owns the region
 * chrome and the region's open/width state, so any provider can compose this child. */
function Inspector({ runtime, context }: ViewProps) {
    return <>{runtime.renderExtensions('aork.workbench.inspector-sections@1', context)}</>;
}
function Sidebar({ runtime, context }: ViewProps) { const layout = layoutContext(context); return <><div className={styles.brand}><strong>Aork</strong>{layout?.narrow && <button aria-label="关闭导航" onClick={() => layout.save({ sidebarOpen: false })}>×</button>}</div><nav aria-label="工作台导航">{runtime.renderExtensions('aork.workbench.navigation@1', context)}</nav><div className={styles.railSections}>{runtime.bootstrap.ui.providers['aork.workspace.navigation@1'] && <div className={styles.workspaceSection}>{runtime.renderView('aork.workspace.navigation@1', context)}</div>}{runtime.bootstrap.ui.providers['aork.sessions.navigation@1'] && <div className={styles.sessionSection}>{runtime.renderView('aork.sessions.navigation@1', context)}</div>}{runtime.renderExtensions('aork.workbench.rail-sections@1', context)}</div><footer>{runtime.renderView('aork.settings@1', context)}{runtime.renderView('aork.auth.controls@1')}</footer></>; }
function Header({ runtime, context }: ViewProps) { const layout = layoutContext(context); const hash = useHash(); const selection = readWorkbenchSelection(hash); const selected = Boolean(selection.workspaceId || selection.sessionId); return <><button aria-label="切换导航" aria-expanded={layout?.preferences.sidebarOpen} onClick={() => layout?.save({ sidebarOpen: !layout.preferences.sidebarOpen, ...(layout.narrow ? { inspectorOpen: false } : {}) })}>☰</button><div className={styles.heading}>{selection.sessionId ? runtime.renderView('aork.sessions.header@1') : <strong>Aork</strong>}</div>{runtime.renderExtensions('aork.workbench.header@1', context)}{runtime.renderExtensions('aork.workbench.toolbar@1', context)}{runtime.renderView('aork.workbench.notifications@1', context)}<button aria-label="切换右侧栏" aria-expanded={layout?.preferences.inspectorOpen} disabled={!selected} onClick={() => layout?.save({ inspectorOpen: !layout.preferences.inspectorOpen, ...(layout.narrow ? { sidebarOpen: false } : {}) })}>▥</button>{runtime.renderView('aork.workbench.menu@1', context)}</>; }
function Main({ runtime }: ViewProps) { const hash = useHash(); const page = new URLSearchParams(hash.slice(1)).get('page'); return page === 'pending' ? runtime.renderView('aork.workbench.pending@1') : page === 'unread' ? runtime.renderView('aork.workbench.unread@1') : runtime.renderView('aork.workbench.home@1'); }
function Home({ runtime }: ViewProps) { return <>{runtime.renderView('aork.workspace.page@1')}</>; }
function PendingLink({ runtime }: ViewProps) { const pending = useSaved(runtime, 'interactions.pendingIndex', pendingIndexSchema.parse); return <button aria-label={`待处理 · ${pending.value?.count ?? '…'}`} onClick={() => go('pending')}>{runtime.icon('pending')} 待处理 · {pending.value?.count ?? '…'}</button>; }
function UnreadIndicator({runtime}:ViewProps){const unread=useSaved(runtime,'workbench.unread',unreadPageSchema.parse);return <button onClick={()=>go('unread')}>未读 · {unread.value?.count??'…'}</button>;}
function Notifications({runtime,context}:ViewProps){return <div className={styles.notifications} aria-label="通知">{runtime.renderExtensions('aork.workbench.notification-sources@1',context)}</div>;}
function Menu({ runtime, context }: ViewProps) {
    const details = useRef<HTMLDetailsElement>(null);
    const summary = useRef<HTMLElement>(null);
    useEffect(() => {
        const close = () => { if (details.current) details.current.open = false; };
        addEventListener('hashchange', close);
        return () => removeEventListener('hashchange', close);
    }, []);
    return (
        <details ref={details} className={styles.menu} onKeyDown={event => {
            if (event.key === 'Escape' && details.current?.open && !(event.target as HTMLElement).closest('dialog')) {
                event.preventDefault();
                details.current.open = false;
                summary.current?.focus();
            }
        }}>
            <summary ref={summary} aria-label="更多菜单">···</summary>
            <div role="menu" onClick={event => {
                if ((event.target as HTMLElement).closest('[role="menuitem"]') && details.current) {
                    details.current.open = false;
                    summary.current?.focus();
                }
            }}>{runtime.renderExtensions('aork.workbench.menu-items@1', context)}</div>
        </details>
    );
}

function Settings({ runtime, context }: ViewProps) { const dialog = useRef<HTMLDialogElement>(null); const layout = layoutContext(context); return <><button onClick={() => dialog.current?.showModal()}>设置</button>{createPortal(<dialog className={styles.settings} ref={dialog} aria-label="工作台设置"><div className={styles.settingsHeader}><h1>工作台设置</h1><label>主题<select aria-label="主题" value={layout?.preferences.theme ?? 'system'} onChange={event => layout?.save({ theme: event.target.value as WorkbenchPreferences['theme'] })}><option value="light">浅色</option><option value="dark">深色</option><option value="system">跟随系统</option></select></label><button onClick={() => dialog.current?.close()} aria-label="关闭设置">关闭</button></div>{runtime.renderExtensions('aork.settings.sections@1')}</dialog>,document.body)}</>; }
function Pending({ runtime }: ViewProps) {
    const [after, setAfter] = useState('');
    const pending = useSaved<PendingIndex>(runtime, 'interactions.pendingIndex', pendingIndexSchema.parse, after ? { after } : {});
    const ids = [...new Set(pending.value?.items.map(item => item.sessionId) ?? [])].join(',');
    const sessions = useSaved(runtime, 'sessions.references', sessionReferencesSchema.parse, ids ? { ids } : {});
    function open(item: PendingIndex['items'][number]) {
        const session = sessions.value?.sessions.find(entry => entry.id === item.sessionId);
        if (!session) return;
        const values = new URLSearchParams(withWorkbenchSelection(location.hash, { workspaceId: session.workspaceId, sessionId: session.id, creatingSession: false }));
        values.set(item.kind === 'form' ? 'input' : 'interaction', item.id);
        location.hash = values.toString();
    }
    return <section className={styles.overview} aria-label="待处理请求列表"><h1>待处理请求</h1><p>{pending.value?.count ?? '…'} 个有效请求</p>{(pending.error || sessions.error) && <p role="alert">{pending.error || sessions.error}</p>}{pending.value?.items.map(item => <article key={item.id}><strong>{item.title}</strong><span>{item.kind === 'form' ? '补充信息' : '权限选择'} · {sessions.value?.sessions.find(entry => entry.id === item.sessionId)?.name ?? '会话不可用'}{sessions.value?.sessions.find(entry => entry.id === item.sessionId)?.nameTruncated&&<small>（名称已缩略）</small>}</span><button disabled={!sessions.value?.sessions.some(entry => entry.id === item.sessionId) || Boolean(pending.error)} aria-label={`打开请求：${item.title}`} onClick={() => open(item)}>打开请求</button></article>)}{pending.value?.count === 0 && <p>没有待处理请求。普通回复和问句不需要审批。</p>}<div>{after && <button onClick={() => setAfter('')}>返回第一页</button>}{pending.value?.next && <button onClick={() => setAfter(pending.value!.next!)}>下一页请求</button>}</div></section>;
}
function Unread({ runtime }: ViewProps) {
    const [after, setAfter] = useState('');
    const unread = useSaved<UnreadPage>(runtime, 'workbench.unread', unreadPageSchema.parse, after ? { after } : {});
    function open(item: UnreadPage['items'][number]) {
        const values = new URLSearchParams(withWorkbenchSelection(location.hash, { workspaceId: item.workspaceId, sessionId: item.sessionId, creatingSession: false }));
        values.set('reply', item.activityId);
        location.hash = values.toString();
    }
    return <section className={styles.overview} aria-label="未读回复列表"><h1>未读回复</h1><p>{unread.value?.count ?? '…'} 条完成回复</p>{unread.error && <p role="alert">{unread.error}</p>}{unread.value?.items.map(item => <article key={item.activityId}><strong>{item.sessionName}</strong><button onClick={() => open(item)}>打开回复</button></article>)}{unread.value?.count === 0 && <p>没有未读回复。</p>}{after && <button onClick={() => setAfter('')}>返回第一页</button>}{unread.value?.next && <button onClick={() => setAfter(unread.value!.next!)}>下一页回复</button>}</section>;
}
function ReadTracker({ runtime, context }: ViewProps) {
    const value = context as ReadTrackerContext | undefined;
    const sessionId = typeof value?.sessionId === 'string' ? value.sessionId : undefined;
    const activityId = typeof value?.activityId === 'string' ? value.activityId : undefined;
    const payloadKey = sessionId && activityId ? JSON.stringify([sessionId, activityId]) : undefined;
    const node = useRef<HTMLDivElement>(null);
    const generation = useRef(0);
    const [failure, setFailure] = useState<{ key: string; message: string }>();
    useLayoutEffect(() => {
        const currentGeneration = ++generation.current;
        if (!payloadKey) return;
        // Public slots may update context without remounting. Capture immutable
        // IDs and bind command identity/in-flight state to this exact payload.
        const payload = { sessionId: sessionId!, activityIds: [activityId!] };
        const commandId = crypto.randomUUID();
        let live = true;
        let attempted = false;
        let completed = false;
        let stop: (() => void | Promise<void>) | undefined;
        let visibility: ReadableContentObserver | undefined;
        const current = () => live && generation.current === currentGeneration;
        const clearRetry = () => { void stop?.(); stop = undefined; };
        setFailure(undefined);
        const submit = () => {
            if (!current() || completed || attempted || !visibility?.readable()) return;
            attempted = true;
            void runtime.command('workbench.markRead', payload, commandId)
                .then(() => {
                    if (!current()) return;
                    completed = true; clearRetry(); visibility?.dispose(); setFailure(undefined);
                })
                .catch(() => {
                    if (!current()) return;
                    setFailure({ key: payloadKey, message: '已读位置尚未同步' });
                    // A compact timeline may precede the Workbench projection.
                    // Retry only this visible immutable payload with its own ID.
                    if (!stop && visibility?.readable() && runtime.bootstrap.access.state === 'authenticated') {
                        try { stop = runtime.observeSnapshot('workbench.unread', {}, { next() { submit(); }, error() {} }, { owners: ['workbench'] }); }
                        catch { /* Revocation can race the rejected read; its access gate clears this view. */ }
                    }
                })
                .finally(() => { if (current()) attempted = false; });
        };
        if (node.current) visibility = observeReadableContent(node.current, readable => { if (readable) submit(); else clearRetry(); });
        // Layout-effect cleanup fences old attempts at the same commit which
        // exposes a new public context, before observer/network callbacks run.
        return () => { live = false; ++generation.current; visibility?.dispose(); clearRetry(); };
    }, [runtime, payloadKey, sessionId, activityId]);
    if (!payloadKey) return <p role="alert">READ_TRACKER_CONTEXT_INVALID</p>;
    return <div ref={node} id={`reply-${activityId}`}>{value!.content}{failure?.key === payloadKey && <small role="status">{failure.message}</small>}</div>;
}

export function activate(context: ClientPluginContext) { for (const [id, view] of Object.entries({ layout: Layout, sidebar: Sidebar, header: Header, main: Main, inspector: Inspector, home: Home, settings: Settings, menu: Menu, notifications: Notifications, pending: Pending, unread: Unread, 'read-tracker': ReadTracker }))
    context.registerView(id, view); context.registerExtension('pending-link', PendingLink);context.registerExtension('new-session',()=> <button aria-label="新建会话" onClick={()=>{location.hash=withWorkbenchSelection(location.hash,{creatingSession:true});}}>＋ 新建会话</button>);context.registerExtension('workspaces-link',({runtime})=><button onClick={()=>go('workspaces')}>{runtime.icon('workspace')} 所有工作区</button>);context.registerExtension('menu-pending',()=> <button role="menuitem" onClick={()=>go('pending')}>待处理请求</button>);context.registerExtension('menu-unread',()=> <button role="menuitem" onClick={()=>go('unread')}>未读回复</button>);context.registerExtension('unread-indicator',UnreadIndicator); context.registerTheme('theme', { version: 1, tokens: { ...light, '--aork-font': 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif' } }); context.registerIcons('icons', { version: 1, icons: { workspace: '▣', settings: '⚙', diagnostics: 'ⓘ', pending: '◷', session: '◌', files: '▥', unread: '●' } }); }
