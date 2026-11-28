import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {createPortal}from'react-dom';
import type { PointerEvent, ReactNode } from 'react';
import type { ClientPluginContext, UiExtension, UiRuntime, ViewProps } from '@aork/sdk/client';
import { defaultPreferences, preferencesSchema, readPreferences, unreadPageSchema, WORKBENCH_INSPECTOR, WORKBENCH_INSPECTOR_TABS, type WorkbenchPreferences, type UnreadPage, type ReadTrackerContext, type WorkbenchLayoutContext, type InspectorTabContext } from '@aork/contracts/workbench';
import { pendingIndexSchema, type PendingIndex } from '@aork/contracts/interaction';
import { SESSION_CREATE, sessionReferencesSchema } from '@aork/contracts/session';
import { readWorkbenchSelection, withWorkbenchSelection } from '@aork/contracts/workspace';
import { DockGlyph, DockIconButton, DockSurface, dockedPanes, emptyLayout, findTab, findTabByContent, findTabByKind, paneHasKind, useDockController, validateLayout } from '@aork/dock';
import type { DockController, DockOp, DockSettle, DockTabDescriptor, LayoutState, PaneId, TabId, TabRecord } from '@aork/dock';
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
    });
    const values = new URLSearchParams(selection);
    values.set('page', page);
    location.hash = values.toString();
}
type LayoutContext = WorkbenchLayoutContext;
function layoutContext(context: unknown): LayoutContext | undefined { return context && typeof context === 'object' && 'preferences' in context && preferencesSchema.safeParse(context.preferences).success && 'save' in context && typeof context.save === 'function' && 'narrow' in context && typeof context.narrow === 'boolean' ? context as LayoutContext : undefined; }
function useViewportWidth() {
    const [width, setWidth] = useState(() => window.innerWidth);
    useEffect(() => {
        const resize = () => setWidth(window.innerWidth);
        window.addEventListener('resize', resize);
        return () => window.removeEventListener('resize', resize);
    }, []);
    return width;
}
function InspectorResize({ width, min, max, resize }: { width: number; min: number; max: number; resize(width: number): void }) {
    const drag = useRef<{ x: number; width: number }>(null);
    function stop(event: PointerEvent<HTMLDivElement>) {
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }
    return <div className={styles.resizeHandle} role="separator" tabIndex={0} aria-label="调整右侧栏宽度" aria-orientation="vertical" aria-valuemin={min} aria-valuemax={max} aria-valuenow={width}
        onPointerDown={event => {
            if (!event.isPrimary || event.button !== 0) return;
            drag.current = { x: event.clientX, width };
            event.currentTarget.setPointerCapture(event.pointerId);
            event.currentTarget.focus({ preventScroll: true });
        }}
        onPointerMove={event => {
            if (drag.current && event.currentTarget.hasPointerCapture(event.pointerId)) resize(drag.current.width + drag.current.x - event.clientX);
        }}
        onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={() => { drag.current = null; }}
        onKeyDown={event => {
            const next = { ArrowLeft: width + 24, ArrowRight: width - 24, Home: min, End: max }[event.key];
            if (next === undefined) return;
            event.preventDefault();
            resize(next);
        }} />;
}
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
/** The region's strip controls share the docking kit's stroke (16px frame, 15px drawn). */
function FullscreenGlyph() {
    return <DockGlyph><path d="M6 2.5H4A1.5 1.5 0 0 0 2.5 4v2M10 2.5h2A1.5 1.5 0 0 1 13.5 4v2M6 13.5H4A1.5 1.5 0 0 1 2.5 12v-2M10 13.5h2a1.5 1.5 0 0 0 1.5-1.5v-2" /></DockGlyph>;
}
function ExitFullscreenGlyph() {
    return <DockGlyph><path d="M2.5 6H6a1 1 0 0 0 1-1V2.5M13.5 6H10a1 1 0 0 1-1-1V2.5M2.5 10H6a1 1 0 0 1 1 1v2.5M13.5 10H10a1 1 0 0 0-1 1v2.5" /></DockGlyph>;
}
function ResizeHorizontalGlyph() {
    return <DockGlyph><path d="M5 5.5L2.5 8 5 10.5M11 5.5L13.5 8 11 10.5M2.5 8h11" /></DockGlyph>;
}
/** A panel with its right column: the same affordance as the header's region toggle. */
function PanelRightGlyph() {
    return <DockGlyph><rect x="2" y="2.5" width="12" height="11" rx="2" /><path d="M10 2.5v11" /></DockGlyph>;
}
function Layout({ runtime }: ViewProps) {
    const saved = useSaved(runtime, 'workbench.preferences', readPreferences);
    const [preferences, setPreferences] = useState(defaultPreferences);
    const [error, setError] = useState('');
    const viewportWidth = useViewportWidth();
    const narrow = viewportWidth < 800;
    const inspectorOverlay = viewportWidth < 1150;
    const [mobileSurface, setMobileSurface] = useState<'sidebar' | 'inspector' | null>(null);
    const [resizedWidth, setResizedWidth] = useState<number>();
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
    // The layout owns the region's width and close actions so a replaced container never loses
    // them. The default inspector seats them at the end of its tab strip; any other container
    // gets the same controls as a floating fallback, since it seats nothing of ours.
    const inspectorSeated = runtime.bootstrap.ui.providers[WORKBENCH_INSPECTOR] === 'workbench:inspector';
    const inspectorChrome = <>
        {!inspectorOverlay && <span className={styles.wideSeat}><DockIconButton label="切换右侧栏宽度" pressed={preferences.inspectorWide} onClick={() => { setResizedWidth(undefined); save({ inspectorWide: !preferences.inspectorWide }); }}><ResizeHorizontalGlyph /></DockIconButton></span>}
        <DockIconButton label="关闭右侧栏" onClick={() => save({ inspectorOpen: false })}><PanelRightGlyph /></DockIconButton>
    </>;
    const context: LayoutContext = { preferences: effective, save, narrow, inspectorOverlay, inspectorChrome };
    useEffect(() => { if(runtime.bootstrap.ui.providers['aork.ui.theme@1']!=='workbench:theme')return;const media = matchMedia('(prefers-color-scheme:dark)'); const apply = () => { const selected = preferences.theme === 'system' ? (media.matches ? 'dark' : 'light') : preferences.theme; document.documentElement.dataset.aorkTheme = selected; document.documentElement.style.colorScheme = selected; for (const [token, value] of Object.entries(selected === 'dark' ? dark : light))
        document.documentElement.style.setProperty(token, value); }; apply(); media.addEventListener('change', apply); return () => media.removeEventListener('change', apply); }, [preferences.theme]);
    const sidebarVisible = effective.sidebarOpen;
    // The right region belongs to whatever the selected inspector provider shows; Files is
    // only the default section inside it. Both region switches keep their own state.
    const inspectorVisible = canOpenInspector(runtime, selection) && effective.inspectorOpen;
    const railWidth = sidebarVisible && !narrow ? 264 : 0;
    const inspectorMin = 360;
    const inspectorMax = Math.max(inspectorMin, viewportWidth - railWidth - 420);
    const preferredWidth = preferences.inspectorWide ? viewportWidth * 0.54 : Math.max(424, Math.min(500, viewportWidth * 0.3));
    const clampWidth = (width: number) => Math.round(Math.max(inspectorMin, Math.min(inspectorMax, width)));
    const inspectorWidth = clampWidth(resizedWidth ?? preferredWidth);
    const rightDrawerOpen = inspectorOverlay && inspectorVisible;
    const leftDrawerOpen = narrow && sidebarVisible;
    useEffect(() => { setMobileSurface(null); }, [selection.workspaceId, selection.sessionId, selection.creatingSession, new URLSearchParams(hash.slice(1)).get('page')]);
    useDrawer(rail, narrow && sidebarVisible, () => save({ sidebarOpen: false }));
    useDrawer(inspector, inspectorOverlay && inspectorVisible, () => save({ inspectorOpen: false }));
    return <div className={styles.layout} data-sidebar={sidebarVisible ? 'open' : 'closed'} data-inspector={inspectorVisible ? 'open' : 'closed'} data-wide={preferences.inspectorWide} style={{ gridTemplateColumns: `${railWidth}px minmax(0, 1fr) ${inspectorVisible && !inspectorOverlay ? inspectorWidth : 0}px` }}>
        <aside ref={rail} data-region="left" hidden={!sidebarVisible} className={styles.rail} inert={rightDrawerOpen || undefined} aria-label="工作台侧栏" role={narrow ? 'dialog' : undefined} aria-modal={narrow ? true : undefined}>
            {runtime.renderView('aork.workbench.sidebar@1', context)}
        </aside>
        <div className={styles.center} data-region="center" inert={leftDrawerOpen || rightDrawerOpen || undefined}>
            <header className={styles.header}>{runtime.renderView('aork.workbench.header-view@1', context)}</header>
            {runtime.renderExtensions('aork.workbench.conversation@1', context)}
            <main className={styles.content}>{runtime.renderView('aork.workbench.main@1', context)}</main>
        </div>
        <aside ref={inspector} data-region="right" hidden={!inspectorVisible} className={styles.inspector} aria-label="右侧栏" role={inspectorOverlay ? 'dialog' : undefined} aria-modal={inspectorOverlay ? true : undefined}>
            {!inspectorOverlay && inspectorVisible && <InspectorResize width={inspectorWidth} min={inspectorMin} max={inspectorMax} resize={width => setResizedWidth(clampWidth(width))} />}
            {!inspectorSeated && <div className={styles.regionControls}>{inspectorChrome}</div>}
            <div className={styles.inspectorBody}>{runtime.renderView('aork.workbench.inspector@1', context)}</div>
        </aside>
        {(leftDrawerOpen || rightDrawerOpen) && <div className={styles.drawerBackdrop} aria-hidden="true" onClick={() => save(leftDrawerOpen ? { sidebarOpen: false } : { inspectorOpen: false })} />}
        {(error || saved.error) && <p className={styles.preferenceError} role="alert">布局偏好同步失败：{error || saved.error}</p>}
    </div>;
}
function showsInlineCreate(runtime: UiRuntime, selection: ReturnType<typeof readWorkbenchSelection>) {
    return selection.creatingSession && runtime.bootstrap.ui.providers[SESSION_CREATE] === 'sessions:create';
}
function canOpenInspector(runtime: UiRuntime, selection: ReturnType<typeof readWorkbenchSelection>) {
    // Composing a new Session over an existing one hides that Session's region, which is its own. A Workspace
    // on its own — the new-Session surface with nothing else selected — keeps its region, as a page of its own did.
    return !(showsInlineCreate(runtime, selection) && selection.sessionId) && Boolean(selection.workspaceId || selection.sessionId);
}
/** Right-region dock in dsh's form: the tab strip is the region's whole top edge — chips, the add
 * control, the split control and, in the top-right pane, the region's own chrome. A region with
 * nothing open shows its default page: the start page when no panel type or several are installed,
 * and the type itself when exactly one is. The start page lists one capsule per installed panel
 * type; picking a capsule opens that type as a tab in the start page's place, so the start page is
 * a doorway rather than a page that stays open. Panel types are ordinary extensions on
 * `aork.workbench.inspector-tabs@1`; a tab shows one piece of content, and each Session keeps its
 * own layout in the browser. */
const GUIDE_KIND = 'guide';
const INSPECTOR_STORAGE = 'aork.inspector.v1';
/** A chip's title is whatever a panel body last set for its tab, kept so the chip reads right
 * again before that body mounts. */
const TAB_TITLE_LIMIT = 120;
/** How long a revealed pane glows; mirrors the stylesheet's animation. */
const FLASH_DURATION = 600;
/** For a layout context that offers no way to save: a panel asking to change a preference changes nothing. */
const keepPreferences = (): void => { /* there is nothing to save into */ };
interface InspectorRecord { version: 2; layout: LayoutState; fullscreen: boolean; titles?: Record<string, string> }
/** The compass: the start page's own mark, on its chip and above its capsules. */
function CompassGlyph({ size = 16 }: { size?: number }) {
    return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1" aria-hidden="true"><circle cx="8" cy="8" r="6.4" /><path d="M10.9 5.1l-1.7 4.1-4.1 1.7 1.7-4.1z" fill="currentColor" stroke="none" /></svg>;
}
/** A cube: the placeholder a panel type shows when it registered no icon. */
function CubeGlyph() {
    return <svg width="22" height="22" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" aria-hidden="true"><path d="M8 2.5l4.9 2.7v5.6L8 13.5 3.1 10.8V5.2z" /><path d="M3.1 5.2L8 7.9l4.9-2.7M8 7.9v5.6" /></svg>;
}
const START: DockTabDescriptor = { kind: GUIDE_KIND, title: '开始', icon: <CompassGlyph /> };
const freshRecord = (): InspectorRecord => ({ version: 2, layout: emptyLayout(), fullscreen: false });
function inspectorStorageKey(sessionId: string | null): string { return `${INSPECTOR_STORAGE}.${sessionId ?? 'default'}`; }
/** A saved layout is adopted only when it passes the kit's validation, so the region never
 * renders a half-restored dock; anything else is dropped and the region starts fresh. Titles are
 * only how chips read, so a malformed set is dropped on its own without taking the layout with it. */
function loadInspectorRecord(key: string): InspectorRecord {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return freshRecord();
    const saved = JSON.parse(raw) as Partial<InspectorRecord>;
    const layout = saved.version === 2 ? validateLayout(saved.layout) : undefined;
    if (layout) {
      const titles = saved.titles;
      return { version: 2, layout, fullscreen: saved.fullscreen === true, ...(titles && typeof titles === 'object' && !Array.isArray(titles) ? { titles: readTitles(titles) } : {}) };
    }
    localStorage.removeItem(key);
  } catch { /* unreadable storage: the region starts fresh and keeps its layout in memory */ }
  return freshRecord();
}
function readTitles(saved: Record<string, unknown>): Record<string, string> {
  const titles: Record<string, string> = {};
  for (const [id, title] of Object.entries(saved)) if (typeof title === 'string' && id.length <= 128) titles[id] = title.slice(0, TAB_TITLE_LIMIT);
  return titles;
}
/** Whether `tabId` is the one tab docked in the region. Floats do not count: a tab floating
 * while the dock shows one start page still leaves that start page holding the region up. */
function soleDockedTab(state: LayoutState, tabId: TabId): boolean {
  const panes = dockedPanes(state);
  return panes.length === 1 && panes[0]!.tabs.length === 1 && panes[0]!.tabs[0] === tabId;
}
function Inspector({ runtime, context }: ViewProps) {
    const hash = useHash();
    const sessionId = readWorkbenchSelection(hash).sessionId;
    const key = inspectorStorageKey(sessionId);
    return <InspectorDock key={key} runtime={runtime} context={context} storageKey={key} sessionId={sessionId} params={new URLSearchParams(hash.replace(/^#/, ''))} />;
}
function InspectorDock({ runtime, context, storageKey, sessionId, params }: { runtime: UiRuntime; context?: unknown; storageKey: string; sessionId: string | null; params: URLSearchParams }) {
    const layout = layoutContext(context);
    const [initial] = useState(() => loadInspectorRecord(storageKey));
    const [fullscreen, setFullscreen] = useState(initial.fullscreen);
    const [titles, setTitles] = useState<Record<string, string>>(() => initial.titles ?? {});
    const extensions = useMemo(() => runtime.listExtensions(WORKBENCH_INSPECTOR_TABS), [runtime]);
    const known = useMemo(() => new Set([GUIDE_KIND, ...extensions.map(extension => extension.id)]), [extensions]);
    const several = useMemo(() => new Set(extensions.filter(extension => extension.multiple).map(extension => extension.id)), [extensions]);
    // A docked region never stays empty. What an emptied one returns to follows dsh: the one
    // installed type opens itself, while no type or several open the start page.
    const only = extensions.length === 1 ? extensions[0] : undefined;
    // An instance of a multi-instance type needs an identity of its own; a seeded one keeps the
    // identity it was first given for as long as this region is mounted.
    const seedContent = useMemo(() => only && several.has(only.id) ? crypto.randomUUID() : undefined, [only, several]);
    const settle = useCallback<DockSettle>(state => state.rootId ? undefined : [{ type: 'open-tab', kind: only?.id ?? GUIDE_KIND, ...(seedContent === undefined ? {} : { content: seedContent }) }], [only, seedContent]);
    const controller = useDockController(initial.layout, { settle });
    // A tab's signal is aborted before its record is removed, on every route a removal can take,
    // so a body can tell its tab closing from being switched away from. Switching tabs, collapsing
    // the region and changing Session remove nothing and abort nothing.
    const signals = useRef(new Map<string, AbortController>());
    const dock = useMemo<DockController>(() => ({
        get state() { return controller.state; },
        apply(ops) {
            for (const op of Array.isArray(ops) ? ops : [ops]) if (op.type === 'close-tab') signals.current.get(op.tabId)?.abort();
            controller.apply(ops);
        },
        beginGesture: controller.beginGesture,
        endGesture: controller.endGesture,
        undo: controller.undo,
        redo: controller.redo,
        canUndo: controller.canUndo,
        canRedo: controller.canRedo,
        reset: controller.reset,
    }), [controller]);
    const state = dock.state;
    const panes = dockedPanes(state);
    // The pane to glow once: a reveal of a tab that was already on screen changes nothing visible by itself.
    const [flash, setFlash] = useState<{ paneId: PaneId; serial: number }>();
    const root = useRef<HTMLDivElement>(null);
    // A saved layout may name panel types that are no longer installed.
    useEffect(() => {
        const stale = Object.values(state.tabs).filter(tab => !known.has(tab.kind));
        if (stale.length) dock.apply(stale.map(tab => ({ type: 'close-tab' as const, tabId: tab.id })));
    }, [dock, known, state.tabs]);
    /** Opens panel types, each into `paneId`, else the first docked pane. A type that holds a
     * single instance is focused where it already shows instead of opened twice. A type that
     * holds several is focused when this content already shows, and opened as a new instance
     * otherwise — with an identity of its own whenever the caller gave none. */
    const open = useCallback((kinds: readonly string[], options: { paneId?: PaneId; replaceTabId?: TabId; content?: string } = {}) => {
        const current = dock.state;
        const first = dockedPanes(current)[0];
        const chosen = options.paneId ? current.nodes[options.paneId] : undefined;
        const pane = chosen?.type === 'pane' && chosen.host === 'docked' ? chosen : first;
        const replaced = pane && options.replaceTabId && pane.tabs.includes(options.replaceTabId) ? pane.tabs.indexOf(options.replaceTabId) : undefined;
        const ops: DockOp[] = [];
        // Tabs opened for content that was not showing, and panes whose selected tab was asked for again.
        let opened = 0;
        const revealed: PaneId[] = [];
        kinds.forEach((kind, offset) => {
            const instances = several.has(kind);
            const showing = instances ? (options.content === undefined ? undefined : findTabByContent(current, kind, options.content)) : findTabByKind(current, kind);
            if (showing) {
                ops.push({ type: 'activate-tab', paneId: showing.pane.id, tabId: showing.tab.id });
                // Already this pane's selected tab: the reveal switches nothing, so the pane will say so with a glow.
                if (showing.pane.active === showing.tab.id) revealed.push(showing.pane.id);
            } else {
                opened++;
                const content = instances ? options.content ?? crypto.randomUUID() : undefined;
                ops.push({ type: 'open-tab', kind, ...(pane ? { paneId: pane.id } : {}), ...(replaced === undefined ? {} : { index: replaced + offset }), ...(content === undefined ? {} : { content }) });
            }
        });
        // A tab lending its place gives it up only to content that was not open before: what was
        // already showing elsewhere is revealed where it is, and the tab that asked stays. The
        // start page is the exception, as in dsh: a doorway closes once it has led somewhere, even
        // to a reveal — unless it is the region's one tab, which nothing closes.
        const lending = options.replaceTabId ? current.tabs[options.replaceTabId] : undefined;
        if (lending && (opened > 0 || lending.kind === GUIDE_KIND && !soleDockedTab(current, lending.id))) ops.push({ type: 'close-tab', tabId: lending.id });
        dock.apply(ops);
        if (revealed.length) setFlash(previous => ({ paneId: revealed.at(-1)!, serial: (previous?.serial ?? 0) + 1 }));
    }, [dock, several]);
    // The start page showing as the region's only tab is its floor: closing that is what the
    // region's own close control is for.
    const lone = panes.length === 1 && panes[0]!.tabs.length === 1 && state.tabs[panes[0]!.tabs[0]!]?.kind === GUIDE_KIND;
    // A selection that carries a type's declared trigger — a `file` link for Files, a `preview`
    // link for the preview — opens that type in place of the start page, the same as picking it
    // there. A multi-instance type opens the link's content once; a later link naming content
    // that is already open brings its tab forward instead. The link stays in the address, so it is
    // answered when what it names changes, not whenever this effect runs again.
    const triggered = extensions.flatMap(extension => {
        const content = extension.opensWith ? params.get(extension.opensWith) : null;
        return content ? [{ kind: extension.id, content, instances: extension.multiple === true }] : [];
    });
    const triggerKey = triggered.map(item => `${item.kind}\u0000${item.content}`).join('\u0001');
    const handled = useRef<string | undefined>(undefined);
    useEffect(() => {
        if (handled.current === triggerKey) return;
        handled.current = triggerKey;
        const current = dock.state;
        const first = dockedPanes(current)[0];
        // A start page showing alone hands its place over to what the link opens.
        const start = first?.tabs.length === 1 && current.tabs[first.tabs[0]!]?.kind === GUIDE_KIND ? first.tabs[0] : undefined;
        const missing: typeof triggered = [];
        for (const item of triggered) {
            // A single-instance type is brought forward by the link only where it is not showing yet.
            if (item.instances && findTabByContent(current, item.kind, item.content)) open([item.kind], { content: item.content });
            else if (!item.instances && findTabByKind(current, item.kind)) continue;
            else missing.push(item);
        }
        for (const [index, item] of missing.entries()) open([item.kind], { ...(index === 0 && start !== undefined ? { replaceTabId: start } : {}), ...(item.instances ? { content: item.content } : {}) });
    }, [dock, open, triggerKey]);
    /** Splits are always side by side and never exceed two panes. The new pane opens on the
     * start page; a tab dropped on the edge takes it instead, and the pane that tab leaves empty
     * returns to the start page. */
    const split = useCallback((paneId: PaneId, side: 'left' | 'right', tabId?: TabId) => {
        dock.apply({ type: 'split-pane', paneId, side: side === 'left' ? 'before' : 'after', direction: 'row', ...(tabId ? { seed: { tabId }, refillKind: GUIDE_KIND } : { seed: { kind: GUIDE_KIND } }) });
    }, [dock]);
    /** Opens `content` with whichever installed type declares `trigger`, as asked by the body of
     * the tab `fromId`: into that tab's pane when it is docked, and closing that tab in the same
     * step when it hands its place over. */
    const openFrom = useCallback((fromId: string, trigger: string, content: string, options?: { replace?: boolean }) => {
        const kinds = extensions.filter(extension => extension.opensWith === trigger).map(extension => extension.id);
        if (!kinds.length) return;
        const from = findTab(dock.state, fromId as TabId);
        open(kinds, { content, ...(from?.pane.host === 'docked' ? { paneId: from.pane.id } : {}), ...(options?.replace && from ? { replaceTabId: from.tab.id } : {}) });
    }, [dock, extensions, open]);
    // Each tab's part of its body's context is built once and then reused, so a body can hold
    // `tab.signal` and the tab's actions across renders. The layout context around it is not stable.
    const tabParts = useRef(new Map<string, InspectorTabContext['tab']>());
    const bodyContext = useCallback((record: TabRecord, floating: boolean): InspectorTabContext => {
        const key = `${record.id}\u0000${floating}`;
        let tab = tabParts.current.get(key);
        if (!tab) {
            let controller = signals.current.get(record.id);
            if (!controller) { controller = new AbortController(); signals.current.set(record.id, controller); }
            const { id } = record;
            tab = Object.freeze({
                id, sessionId, kind: record.kind, floating, signal: controller.signal,
                ...(record.content === undefined ? {} : { content: record.content }),
                open: (trigger: string, content: string, options?: { replace?: boolean }) => openFrom(id, trigger, content, options),
                close: () => dock.apply({ type: 'close-tab', tabId: record.id }),
                setTitle: (title: string) => setTitles(current => current[id] === title ? current : { ...current, [id]: title.slice(0, TAB_TITLE_LIMIT) }),
            });
            tabParts.current.set(key, tab);
        }
        return {
            preferences: layout?.preferences ?? defaultPreferences,
            save: layout?.save ?? keepPreferences,
            narrow: layout?.narrow ?? false,
            ...(layout?.inspectorOverlay !== undefined ? { inspectorOverlay: layout.inspectorOverlay } : {}),
            ...(layout?.inspectorChrome !== undefined ? { inspectorChrome: layout.inspectorChrome } : {}),
            tab,
        };
    }, [dock, sessionId, layout?.preferences, layout?.save, layout?.narrow, layout?.inspectorOverlay, layout?.inspectorChrome, openFrom]);
    useEffect(() => {
        try {
            // Titles belong to their tabs: a closed tab's title is not worth carrying forward.
            const kept = Object.fromEntries(Object.entries(titles).filter(([id]) => state.tabs[id] !== undefined));
            localStorage.setItem(storageKey, JSON.stringify({ version: 2, layout: state, fullscreen, ...(Object.keys(kept).length ? { titles: kept } : {}) } satisfies InspectorRecord));
        } catch { /* storage unavailable: the layout stays in memory */ }
    }, [state, fullscreen, titles, storageKey]);
    // A chip reads what its tab's body last set for it, and the type's label until then.
    const descriptors = useMemo<DockTabDescriptor[]>(() => [START, ...extensions.map(extension => ({ kind: extension.id, title: (record: TabRecord): string => titles[record.id] ?? extension.label ?? extension.id, ...(extension.icon ? { icon: runtime.icon(extension.icon) } : {}) }))], [extensions, runtime, titles]);
    const overlay = layout?.inspectorOverlay === true;
    const chrome = <>
        {!overlay && <DockIconButton label={fullscreen ? '退出全屏' : '全屏右侧栏'} pressed={fullscreen} onClick={() => setFullscreen(value => !value)}>{fullscreen ? <ExitFullscreenGlyph /> : <FullscreenGlyph />}</DockIconButton>}
        {layout?.inspectorChrome}
    </>;
    const surface = <DockSurface dock={dock} tabs={descriptors} chrome={chrome}
        canSplit={panes.length < 2}
        canAddTab={paneId => !paneHasKind(state, paneId, GUIDE_KIND)}
        canCloseTab={tabId => !(lone && state.tabs[tabId]?.kind === GUIDE_KIND)}
        onAddTab={paneId => dock.apply({ type: 'open-tab', kind: GUIDE_KIND, paneId })}
        onSplit={split}
        renderBody={(descriptor, record, options) => {
            const paneId = findTab(state, record.id)?.pane.id;
            return descriptor.kind === GUIDE_KIND
                ? <GuideBody runtime={runtime} extensions={extensions} pick={kind => open([kind], { replaceTabId: record.id, ...(paneId !== undefined ? { paneId } : {}) })} />
                : runtime.renderExtension(WORKBENCH_INSPECTOR_TABS, descriptor.kind, bodyContext(record, options.floating));
        }} />;
    // The glow a reveal asks for: marked on the pane for one animation. A pane that is not on
    // screen — the region is collapsed, or the tab sits in a hidden pane — has nothing to glow for.
    useEffect(() => {
        if (!flash) return undefined;
        const pane = root.current?.querySelector<HTMLElement>(`[data-dock-pane="${flash.paneId}"], [data-dock-float="${flash.paneId}"]`);
        if (!pane || !pane.getClientRects().length) return undefined;
        pane.dataset.dockFlash = flash.serial % 2 === 0 ? 'even' : 'odd';
        const clear = (): void => { delete pane.dataset.dockFlash; };
        pane.addEventListener('animationend', clear);
        pane.addEventListener('animationcancel', clear);
        // The stylesheet owns the duration; this only keeps the mark from outstaying it.
        const timer = setTimeout(clear, FLASH_DURATION + 400);
        return () => { clearTimeout(timer); pane.removeEventListener('animationend', clear); pane.removeEventListener('animationcancel', clear); };
    }, [flash]);
    // One element in both presentations, so entering or leaving fullscreen moves nothing in the
    // tree: a body keeps its state, and nothing remounts.
    return <div ref={root} className={fullscreen ? styles.dockFullscreen : styles.dockInline} data-inspector-dock data-inspector-fullscreen={fullscreen ? '' : undefined}>{surface}</div>;
}
/** The start page: a muted compass over one capsule per installed panel type, centred in the pane
 * and scrolling from the top when taller than it. It carries no caption of its own; while four
 * capsules or fewer are listed, each shows its one-line description. */
function GuideBody({ runtime, extensions, pick }: { runtime: UiRuntime; extensions: readonly UiExtension[]; pick(kind: string): void }) {
    const described = extensions.length <= 4;
    return <div className={styles.guide} data-inspector-guide>
        <span className={styles.guideHero} aria-hidden="true"><CompassGlyph size={56} /></span>
        <div className={styles.guideEntries} role="group" aria-label="打开面板">
            {extensions.map(extension => <button key={extension.id} type="button" className={styles.guideEntry} data-inspector-entry={extension.id} onClick={() => pick(extension.id)}>
                <span className={styles.guideEntryIcon} aria-hidden="true">{extension.icon ? runtime.icon(extension.icon) : <CubeGlyph />}</span>
                <span className={styles.guideEntryText}>
                    <span className={styles.guideEntryTitle}>{extension.label ?? extension.id}</span>
                    {described && extension.description && <span className={styles.guideEntryDescription}>{extension.description}</span>}
                </span>
            </button>)}
        </div>
        {!extensions.length && <p className={styles.guideEmpty}>当前没有插件提供右侧栏面板。</p>}
    </div>;
}
function Sidebar({ runtime, context }: ViewProps) {
    const layout = layoutContext(context);
    const providers = runtime.bootstrap.ui.providers;
    return <>
        <div className={styles.brand}>
            <strong>Aork</strong>
            {layout?.narrow && <button className={styles.iconButton} aria-label="关闭导航" onClick={() => layout.save({ sidebarOpen: false })}>×</button>}
        </div>
        <nav className={styles.navigation} aria-label="工作台导航">{runtime.renderExtensions('aork.workbench.navigation@1', context)}</nav>
        <div className={styles.railSections}>
            {/* One browsing region: the Workspace browser draws Workspace rows and, through the Sessions plugin's rows view, the Sessions under them. */}
            {providers['aork.workspace.navigation@1'] && <div className={styles.workspaceSection}>{runtime.renderView('aork.workspace.navigation@1', context)}</div>}
            {runtime.renderExtensions('aork.workbench.rail-sections@1', context)}
        </div>
        <footer className={styles.railFooter}>{runtime.renderView('aork.settings@1', context)}{runtime.renderView('aork.auth.controls@1')}</footer>
    </>;
}
function Header({ runtime, context }: ViewProps) {
    const layout = layoutContext(context);
    const selection = readWorkbenchSelection(useHash());
    const inspectorEnabled = canOpenInspector(runtime, selection);
    return <>
        <button className={styles.iconButton} data-workbench-navigation-toggle aria-label="切换导航" title="切换导航" aria-expanded={layout?.preferences.sidebarOpen} onClick={() => layout?.save({ sidebarOpen: !layout.preferences.sidebarOpen, ...(layout.narrow ? { inspectorOpen: false } : {}) })}>
            <span aria-hidden="true" className={styles.panelIcon} />
        </button>
        <div className={styles.heading}>{!showsInlineCreate(runtime, selection) && (selection.sessionId ? runtime.renderView('aork.sessions.header@1') : !layout?.preferences.sidebarOpen && <strong>Aork</strong>)}</div>
        {runtime.renderExtensions('aork.workbench.header@1', context)}
        {runtime.renderExtensions('aork.workbench.toolbar@1', context)}
        {runtime.renderView('aork.workbench.notifications@1', context)}
        <button className={styles.iconButton} aria-label="切换右侧栏" title="切换右侧栏" aria-expanded={Boolean(inspectorEnabled && layout?.preferences.inspectorOpen)} disabled={!inspectorEnabled} onClick={() => layout?.save({ inspectorOpen: !layout.preferences.inspectorOpen, ...(layout.narrow ? { sidebarOpen: false } : {}) })}>
            <span aria-hidden="true" className={`${styles.panelIcon} ${styles.panelIconRight}`} />
        </button>
        {runtime.renderView('aork.workbench.menu@1', context)}
    </>;
}
function NewSession({ context }: ViewProps) {
    const layout = layoutContext(context);
    const { creatingSession } = readWorkbenchSelection(useHash());
    return <button className={styles.newSession} data-create-session-trigger aria-label="新建会话" aria-current={creatingSession ? 'page' : undefined} onClick={() => {
        if (layout?.narrow) layout.save({ sidebarOpen: false });
        location.hash = withWorkbenchSelection(location.hash, { creatingSession: true });
    }}><span aria-hidden="true">＋</span> 新建会话</button>;
}
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

/** Full-window settings layer (ZCode-style): grouped navigation on the left, a rounded
 * panel with a centered content column on the right. Built-in 外观 first, then every
 * `aork.settings.sections@1` extension stays a plugin contribution (ADR-0004). */
interface SettingsEntry { key: string; label: string; icon: string; extensionId?: string }
function Settings({ runtime, context }: ViewProps) {
    const [open, setOpen] = useState(false);
    return <>
        <button aria-haspopup="dialog" onClick={() => setOpen(true)}>设置</button>
        {open && createPortal(<SettingsLayer runtime={runtime} context={context} close={() => setOpen(false)} />, document.body)}
    </>;
}
function SettingsLayer({ runtime, context, close }: { runtime: UiRuntime; context?: unknown; close(): void }) {
    const layout = layoutContext(context);
    const layer = useRef<HTMLDivElement>(null);
    const [active, setActive] = useState('appearance');
    const [query, setQuery] = useState('');
    // Inert is removed before the drawer's focus restore runs (cleanup follows declaration order).
    useEffect(() => { const root = document.getElementById('root'); if (root) root.setAttribute('inert', ''); return () => { const node = document.getElementById('root'); if (node) node.removeAttribute('inert'); }; }, []);
    useDrawer(layer, true, close);
    const extensions = runtime.listExtensions('aork.settings.sections@1');
    const entries: SettingsEntry[] = [
        { key: 'appearance', label: '外观', icon: runtime.icon('settings') },
        ...extensions.map(extension => ({ key: extension.id, label: extension.label ?? extension.id, icon: extension.icon ? runtime.icon(extension.icon) : '▪', extensionId: extension.id })),
    ];
    const needle = query.trim().toLowerCase();
    const visible = needle ? entries.filter(entry => entry.label.toLowerCase().includes(needle)) : entries;
    const current = entries.find(entry => entry.key === active) ?? visible[0] ?? entries[0]!;
    const groups: { title: string; items: SettingsEntry[] }[] = [
        { title: '基础', items: visible.filter(entry => !entry.extensionId) },
        { title: '扩展', items: visible.filter(entry => entry.extensionId) },
    ].filter(group => group.items.length);
    return <div ref={layer} className={styles.settingsLayer} role="dialog" aria-modal="true" aria-label="设置">
        <aside className={styles.settingsNav} aria-label="设置导航">
            <button type="button" className={styles.settingsBack} aria-label="返回工作台" onClick={close}>‹ 返回</button>
            <input className={styles.settingsSearch} type="search" placeholder="搜索设置" aria-label="搜索设置" value={query} onChange={event => setQuery(event.target.value)} />
            <nav className={styles.settingsNavList}>
                {groups.map(group => <div key={group.title} className={styles.settingsNavGroup}>
                    <p className={styles.settingsNavGroupTitle}>{group.title}</p>
                    {/* The name stays on the button itself: below 900px the label is hidden and only the icon draws. */}
                    {group.items.map(entry => <button key={entry.key} type="button" className={styles.settingsNavItem} aria-label={entry.label} title={entry.label} aria-current={current?.key === entry.key ? 'page' : undefined} onClick={() => setActive(entry.key)}>
                        <span aria-hidden="true" className={styles.settingsNavIcon}>{entry.icon}</span><span className={styles.settingsNavLabel}>{entry.label}</span>
                    </button>)}
                </div>)}
                {!groups.length && <p className={styles.settingsNavEmpty}>没有匹配的设置项。</p>}
            </nav>
            <footer className={styles.settingsNavFooter}>{runtime.renderView('aork.auth.controls@1')}</footer>
        </aside>
        <section className={styles.settingsPanel} aria-label="设置内容">
            <header className={styles.settingsBreadcrumb}><span>设置</span><span aria-hidden="true">›</span><strong>{current?.label ?? '设置'}</strong></header>
            <main className={styles.settingsContent}>
                <div className={styles.settingsColumn}>
                    {current?.key === 'appearance' && <AppearanceSection layout={layout} />}
                    {current?.extensionId && runtime.renderExtension('aork.settings.sections@1', current.extensionId)}
                </div>
            </main>
        </section>
    </div>;
}
function AppearanceSection({ layout }: { layout: LayoutContext | undefined }) {
    const theme = layout?.preferences.theme ?? 'system';
    return <div className={styles.settingsCard}>
        <div className={styles.settingsRow}>
            <div className={styles.settingsRowText}>
                <strong>主题</strong>
                <span>选择浅色、深色或跟随系统的界面外观。</span>
            </div>
            <div className={styles.settingsSegmented} role="radiogroup" aria-label="主题">
                {(['light', 'dark', 'system'] as const).map(value => <button key={value} type="button" role="radio" aria-checked={theme === value} onClick={() => layout?.save({ theme: value as WorkbenchPreferences['theme'] })}>{({ light: '浅色', dark: '深色', system: '跟随系统' })[value]}</button>)}
            </div>
        </div>
        <div className={styles.settingsRow}>
            <div className={styles.settingsRowText}>
                <strong>左栏</strong>
                <span>工作台侧栏的默认开关状态。</span>
            </div>
            <div className={styles.settingsSegmented} role="radiogroup" aria-label="左栏默认开关">
                <button type="button" role="radio" aria-checked={layout?.preferences.sidebarOpen === true} onClick={() => layout?.save({ sidebarOpen: true })}>展开</button>
                <button type="button" role="radio" aria-checked={layout?.preferences.sidebarOpen === false} onClick={() => layout?.save({ sidebarOpen: false })}>收起</button>
            </div>
        </div>
    </div>;
}
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
    context.registerView(id, view); context.registerExtension('pending-link', PendingLink);context.registerExtension('new-session',NewSession);context.registerExtension('menu-pending',()=> <button role="menuitem" onClick={()=>go('pending')}>待处理请求</button>);context.registerExtension('menu-unread',()=> <button role="menuitem" onClick={()=>go('unread')}>未读回复</button>);context.registerExtension('unread-indicator',UnreadIndicator); context.registerTheme('theme', { version: 1, tokens: { ...light, '--aork-font': 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif' } }); context.registerIcons('icons', { version: 1, icons: { workspace: '▣', settings: '⚙', diagnostics: 'ⓘ', pending: '◷', session: '◌', files: '▥', unread: '●', plugins: '⬡', terminal: '❯', browser: '◎', preview: '▤' } }); }
