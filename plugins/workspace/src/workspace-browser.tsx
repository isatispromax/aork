import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, FormEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { UiRuntime, ViewProps } from '@aork/sdk/client';
import type { CommandReceipt } from '@aork/sdk/durable';
import { readWorkbenchSelection, withWorkbenchSelection, workspaceOverviewSchema } from '@aork/contracts/workspace';
import type { Workspace, WorkspaceOverview } from '@aork/contracts/workspace';
import { SESSION_ROWS, sessionsProjectionSchema } from '@aork/contracts/session';
import type { SessionRowsContext, SessionsProjection } from '@aork/contracts/session';
import { DirectoryPicker } from './directory-picker.js';
import { FileMenu } from './file-menu.js';
import type { MenuAnchor, MenuItem } from './file-menu.js';
import { HoverCard } from './hover-card.js';
import { ChevronsUpDownIcon, ClockIcon, CloseIcon, CopyIcon, EllipsisIcon, FlatListIcon, FolderCloseIcon, FolderOpenIcon, NewChatIcon, ProjectAddIcon, QueueIcon, SearchIcon, SlidersIcon, TriangleRightIcon, WorkspaceTreeIcon } from './icons.js';
import { ancestorIds, isDescendant, isDropSibling, movedOrder, navTree, siblingAfter } from './workspace-nav.js';
import type { NavNode } from './workspace-nav.js';
import styles from './workspace-browser.module.css';

/** The left region's Workspace browser, in the shape of deepseek-harness's ui-workspace: one tree
 * whose Workspace rows are group headers with their Sessions nested below. This shell owns the
 * toolbar (label, expanding search, view options, add), the Workspace rows — folder glyph, hover
 * card, the ··· menu the right-click shares, drag reorder — and the rename and delete dialogs. The
 * Session rows under each group are the Sessions plugin's `aork.sessions.rows@1` view; without it
 * the browser shows Workspace rows alone. Presentation only — every change goes through a durable
 * command and the server stays authoritative. */

/** The trailing group of Sessions whose Workspace registration is gone. It has no backing Workspace:
 * no row to start a Session in, no menu, no reorder. */
const UNGROUPED = 'ungrouped';
type GroupBy = 'workspace' | 'workspace-tree' | 'flat';
type OrderBy = 'updated' | 'manual';
interface NavView { groupBy: GroupBy; orderBy: OrderBy; collapsed: Record<string, true> }
const NAV_STORE = 'aork.workspace.nav.v2';
const DEFAULT_VIEW: NavView = { groupBy: 'workspace', orderBy: 'updated', collapsed: {} };

/** The viewing state kept across reloads. Entries of Workspaces that are gone are dropped when the
 * Workspace list arrives; a fold recorded for one that returns still applies meanwhile. */
function loadNavView(): NavView {
  try {
    const parsed = JSON.parse(localStorage.getItem(NAV_STORE) ?? '') as Partial<NavView> | null;
    return {
      groupBy: parsed?.groupBy === 'workspace-tree' || parsed?.groupBy === 'flat' ? parsed.groupBy : 'workspace',
      orderBy: parsed?.orderBy === 'manual' ? 'manual' : 'updated',
      collapsed: parsed?.collapsed && typeof parsed.collapsed === 'object' && !Array.isArray(parsed.collapsed)
        ? Object.fromEntries(Object.entries(parsed.collapsed).filter((entry): entry is [string, true] => entry[1] === true)) : {},
    };
  } catch { return DEFAULT_VIEW; }
}

const omit = (record: Record<string, true>, keys: readonly string[]): Record<string, true> => Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));

function select(update: { workspaceId?: string | null; sessionId?: string | null; creatingSession?: boolean }) {
  location.hash = withWorkbenchSelection(location.hash, { workspaceId: null, sessionId: null, creatingSession: false, ...update });
}

/** A Workspace's creation time, in dsh's hover-card form: `2026年11月28日 10:20`. */
function createdLabel(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${at.getFullYear()}年${at.getMonth() + 1}月${at.getDate()}日 ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

type Action = { kind: 'rename'; workspace: Workspace } | { kind: 'delete'; workspace: Workspace };

export function WorkspaceBrowser({ runtime }: ViewProps): ReactNode {
  const [overview, setOverview] = useState<WorkspaceOverview>();
  const [listError, setListError] = useState('');
  const [projection, setProjection] = useState<SessionsProjection>();
  const [chosen, setChosen] = useState(readWorkbenchSelection(location.hash));
  const [view, setView] = useState<NavView>(loadNavView);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<MenuAnchor>();
  const menuFor = useRef<Workspace | undefined>(undefined);
  const [action, setAction] = useState<Action>();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState<{ workspaceId: string; x: number; y: number; over: { id: string; half: 'before' | 'after' } | undefined }>();
  const [reveal, setReveal] = useState<string>();
  const searchInput = useRef<HTMLInputElement>(null);
  const searchRoot = useRef<HTMLDivElement>(null);
  // One command identity per picker opening: retrying the same directory replays the original receipt
  // instead of registering anything twice; another directory is another command.
  const createAttempt = useRef<{ directory: string; commandId: string } | undefined>(undefined);
  // The Session rows are the Sessions plugin's; without that view the browser draws Workspace rows alone.
  const rowsAvailable = runtime.bootstrap.ui.providers[SESSION_ROWS] !== undefined;
  const workspaces: readonly Workspace[] = overview?.workspaces ?? [];
  const treeMode = view.groupBy === 'workspace-tree';
  const searching = searchOpen && query.trim() !== '';

  useEffect(() => { const change = () => setChosen(readWorkbenchSelection(location.hash)); addEventListener('hashchange', change); return () => removeEventListener('hashchange', change); }, []);
  useEffect(() => { let active = true; const unsubscribe = runtime.subscribe<WorkspaceOverview>('workspace.overview', {
    next(value) { if (active) { setOverview(workspaceOverviewSchema.parse(value)); setListError(''); } },
    error(failure) { if (active) setListError(failure.message); },
  }, { intervalMs: 1000 }); return () => { active = false; void unsubscribe(); }; }, [runtime]);
  useEffect(() => {
    if (!rowsAvailable) return;
    let active = true;
    const stop = runtime.observeSnapshot<SessionsProjection>('sessions.overview', {}, { next(value) { if (active) setProjection(sessionsProjectionSchema.parse(value)); }, error() { /* the rows report their own failure */ } }, { owners: ['sessions'] });
    return () => { active = false; void stop(); };
  }, [runtime, rowsAvailable]);
  async function refresh() {
    try { setOverview(workspaceOverviewSchema.parse(await runtime.query('workspace.overview', { cache: 'reload' }))); setListError(''); }
    catch (failure) { setListError(failure instanceof Error ? failure.message : '工作区列表暂时不可用'); }
  }

  const updateView = (update: Partial<NavView>) => setView(current => {
    const next = { ...current, ...update };
    try { localStorage.setItem(NAV_STORE, JSON.stringify(next)); } catch { /* presentation-only */ }
    return next;
  });
  // Folds of Workspaces that are gone are dropped once the list says so.
  useEffect(() => {
    if (!overview) return;
    const stale = Object.keys(view.collapsed).filter(id => id !== UNGROUPED && !workspaces.some(item => item.id === id));
    if (stale.length) updateView({ collapsed: omit(view.collapsed, stale) });
    // Runs when the list changes, not on every fold: the fold it reads is the one of that render.
  }, [overview]);

  const sessionWorkspace = (sessionId: string | null) => sessionId ? projection?.sessions.find(item => item.session.id === sessionId)?.session.workspaceId : undefined;
  // A Session chosen elsewhere — a search result, the address — is revealed: what found it clears and
  // its chain unfolds; so is a Workspace chosen for a new Session. On load nothing is revealed: a
  // saved fold stands and hides the selection.
  const lastSeen = useRef<{ session: string | null; workspace: string | undefined } | undefined>(undefined);
  useEffect(() => {
    const workspaceId = chosen.sessionId ? sessionWorkspace(chosen.sessionId) : chosen.workspaceId ?? undefined;
    const next = { session: chosen.sessionId ?? null, workspace: workspaceId };
    if (lastSeen.current === undefined) { lastSeen.current = next; return; }
    const previous = lastSeen.current;
    lastSeen.current = next;
    if (previous.session === next.session && previous.workspace === next.workspace) return;
    if (next.session) { setQuery(''); setSearchOpen(false); setReveal(next.session); }
    const target = workspaceId ? overview?.workspaces.find(item => item.id === workspaceId) : undefined;
    const chain = target ? [target.id, ...ancestorIds(target, workspaces)] : [];
    if (chain.some(id => view.collapsed[id])) updateView({ collapsed: omit(view.collapsed, chain) });
  }, [chosen.sessionId, chosen.workspaceId, projection]);
  // A reveal nobody acknowledges — no Session rows are installed — is not left pending.
  useEffect(() => { if (!reveal) return; const timer = setTimeout(() => setReveal(undefined), 1500); return () => clearTimeout(timer); }, [reveal]);
  const onRevealed = (sessionId: string) => setReveal(current => current === sessionId ? undefined : current);
  const currentWorkspaceId = sessionWorkspace(chosen.sessionId ?? null) ?? (chosen.sessionId ? undefined : chosen.workspaceId ?? undefined);
  const registered = new Set(workspaces.map(item => item.id));
  // Sessions whose registration is gone trail in 未分组; until the Workspace list lands none is known to be there.
  const ungrouped = rowsAvailable && overview !== undefined && projection !== undefined && projection.sessions.some(item => !registered.has(item.session.workspaceId));

  const toggle = (id: string) => updateView({ collapsed: view.collapsed[id] ? omit(view.collapsed, [id]) : { ...view.collapsed, [id]: true } });
  const createIn = (workspaceId: string) => select({ workspaceId, sessionId: null, creatingSession: true });
  function openCreate() { createAttempt.current = undefined; setCreating(true); }
  // Rejects with the command failure so the picker keeps it in place for another choice.
  async function createWorkspace(directory: string) {
    if (createAttempt.current?.directory !== directory) createAttempt.current = { directory, commandId: crypto.randomUUID() };
    const receipt = await runtime.command<CommandReceipt<Workspace>>('workspace.create', { workspace: { directory } }, createAttempt.current.commandId, { version: 1 });
    setCreating(false); await refresh(); createIn(receipt.result.id);
  }
  function openMenu(event: ReactMouseEvent<HTMLElement>, workspace: Workspace) {
    const trigger = event.currentTarget;
    const box = trigger.getBoundingClientRect();
    menuFor.current = workspace;
    setMenu({ x: box.right, y: box.bottom, align: 'end', returnTo: trigger });
  }
  const menuItems = (): readonly MenuItem[] => {
    const workspace = menuFor.current;
    if (!workspace) return [];
    return [
      { id: 'rename', label: '重命名…', run: () => setAction({ kind: 'rename', workspace }) },
      { id: 'delete', label: '删除工作区…', danger: true, separatorBefore: true, run: () => setAction({ kind: 'delete', workspace }) },
    ];
  };

  // Pointer drag reorder, the session browser's gesture: the row body is the handle, the whole group
  // section — header, child Workspaces, Session rows — is the drop zone, and only siblings trade places.
  const gesture = useRef<{ workspaceId: string; startX: number; startY: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  useEffect(() => {
    if (!dragging) return;
    const over = (event: PointerEvent) => setDragging(current => current ? { ...current, x: event.clientX, y: event.clientY, over: dropAt(event.clientX, event.clientY, current.workspaceId) } : current);
    const up = (event: PointerEvent) => {
      setDragging(current => {
        if (current) void commitOrder(current.workspaceId, dropAt(event.clientX, event.clientY, current.workspaceId));
        return undefined;
      });
    };
    window.addEventListener('pointermove', over);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => { window.removeEventListener('pointermove', over); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
  }, [Boolean(dragging)]);
  /** The group the pointer is over, walked up past descendants and non-siblings to the first one the
   * dragged Workspace may land beside; the half is decided on that group's whole section. */
  function dropAt(x: number, y: number, draggedId: string): { id: string; half: 'before' | 'after' } | undefined {
    let element = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-workspace-group]');
    while (element) {
      const id = element.dataset.workspaceGroup!;
      if (id !== UNGROUPED && id !== draggedId && !isDescendant(draggedId, id, workspaces) && isDropSibling(draggedId, id, workspaces, treeMode)) {
        const rect = element.getBoundingClientRect();
        return { id, half: y < rect.top + rect.height / 2 ? 'before' : 'after' };
      }
      element = element.parentElement?.closest<HTMLElement>('[data-workspace-group]');
    }
    return undefined;
  }
  async function commitOrder(draggedId: string, over: { id: string; half: 'before' | 'after' } | undefined) {
    if (!over) return;
    const orderedIds = movedOrder(workspaces, draggedId, over.half === 'before' ? over.id : siblingAfter(workspaces, over.id, treeMode), treeMode);
    if (!orderedIds) return;
    try { await runtime.command('workspace.reorder', { orderedIds }, crypto.randomUUID(), { version: 1 }); await refresh(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '排序结果未确认，可重试'); }
  }
  function rowPointerDown(event: ReactPointerEvent<HTMLElement>, workspace: Workspace) {
    suppressClick.current = false;
    if (!event.isPrimary || event.button !== 0 || !(event.target instanceof HTMLElement)) return;
    // The row body drags; presses that begin on the ··· or new-Session buttons do not.
    if (event.target.closest('button')) return;
    gesture.current = { workspaceId: workspace.id, startX: event.clientX, startY: event.clientY, moved: false };
  }
  function rowPointerMove(event: ReactPointerEvent<HTMLElement>) {
    const start = gesture.current;
    if (!start || dragging) return;
    if (!start.moved && Math.abs(event.clientX - start.startX) < 6 && Math.abs(event.clientY - start.startY) < 6) return;
    start.moved = true; suppressClick.current = true;
    setDragging({ workspaceId: start.workspaceId, x: event.clientX, y: event.clientY, over: undefined });
  }
  function rowPointerEnd() { gesture.current = null; }

  // Search: a header control that expands into the header's whole width; outside click closes an empty one.
  useEffect(() => { if (searchOpen) searchInput.current?.focus({ preventScroll: true }); }, [searchOpen]);
  useEffect(() => {
    if (!searchOpen) return;
    const onClick = (event: MouseEvent) => {
      if (!(event.target instanceof Node) || searchRoot.current?.contains(event.target)) return;
      searchInput.current?.blur();
      if (query.trim() !== '') return;
      setSearchOpen(false);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [searchOpen, query]);

  const nodes = navTree(workspaces, treeMode, new Set(Object.keys(view.collapsed)));
  const rowsContext = (scope: SessionRowsContext['scope']): SessionRowsContext => ({ scope, orderBy: view.orderBy, depth: 0, onManualOrder: () => updateView({ orderBy: 'manual' }), ...(reveal ? { revealSessionId: reveal } : {}), onRevealed });
  const containsCurrent = (id: string): boolean => currentWorkspaceId === id || (treeMode && currentWorkspaceId !== undefined && isDescendant(id, currentWorkspaceId, workspaces));
  const renderNode = (node: NavNode<Workspace>, depth: number): ReactNode => {
    const { workspace, expanded, children } = node;
    const marker = dragging?.over?.id === workspace.id ? dragging.over.half : undefined;
    return <div key={workspace.id} className={styles.groupSection} data-workspace-group={workspace.id} data-drop={marker}
      style={{ '--workspace-indent': `${depth * 12}px` } as CSSProperties}>
      <WorkspaceRow workspace={workspace} expanded={expanded} active={containsCurrent(workspace.id)} dragging={dragging?.workspaceId === workspace.id}
        menuOpen={menu !== undefined && menuFor.current?.id === workspace.id}
        onToggle={() => toggle(workspace.id)} onCreate={() => createIn(workspace.id)} onMenu={event => openMenu(event, workspace)}
        onPointerDown={event => rowPointerDown(event, workspace)} onPointerMove={rowPointerMove} onPointerEnd={rowPointerEnd}
        onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } toggle(workspace.id); }} />
      {expanded && children.length > 0 && <div role="group">{children.map(child => renderNode(child, depth + 1))}</div>}
      {expanded && rowsAvailable && runtime.renderView(SESSION_ROWS, { ...rowsContext({ kind: 'group', workspaceId: workspace.id }), depth })}
    </div>;
  };
  const empty = overview !== undefined && workspaces.length === 0 && !ungrouped;
  return <section className={styles.browser} aria-label="工作区">
    <div className={styles.sectionHeader} data-sidebar-workspace-header>
      <span className={`${styles.sectionLabel}${searchOpen ? ` ${styles.sectionLabelHidden}` : ''}`}>{view.groupBy === 'flat' ? '会话' : '工作区'}</span>
      <div ref={searchRoot} className={`${styles.searchSlot}${searchOpen ? ` ${styles.searchSlotExpanded}` : ''}`}>
        <div className={`${styles.search}${searchOpen ? ` ${styles.searchExpanded}` : ''}`}>
          <button type="button" className={styles.searchButton} aria-label="搜索会话" aria-expanded={searchOpen}
            onClick={() => { setSearchOpen(true); setQuery(''); }}><SearchIcon size={searchOpen ? 11 : 14} /></button>
          <input ref={searchInput} className={styles.searchInput} type="text" placeholder="搜索会话名称" aria-label="搜索会话" tabIndex={searchOpen ? 0 : -1}
            value={query} onChange={event => setQuery(event.target.value)}
            onKeyDown={event => { if (event.key === 'Escape') { setQuery(''); setSearchOpen(false); } }} />
          {searchOpen && <button type="button" className={styles.clearButton} aria-label="清除搜索" onClick={() => { setQuery(''); setSearchOpen(false); }}><CloseIcon /></button>}
        </div>
      </div>
      <div className={`${styles.headerActions}${searchOpen ? ` ${styles.headerActionsHidden}` : ''}`}>
        <ViewOptionsMenu view={view} choose={updateView} />
        <button type="button" className={styles.iconButton} aria-label="添加工作区" title="添加工作区" onClick={openCreate}><ProjectAddIcon /></button>
      </div>
    </div>
    {listError && <p role="alert" className={styles.error}>{listError}</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <div className={styles.listArea} data-sidebar-list-area>
      {!overview && !listError && <p role="status" className={styles.status}>正在加载工作区…</p>}
      {overview && (searching
        ? rowsAvailable && runtime.renderView(SESSION_ROWS, rowsContext({ kind: 'search', query }))
        : view.groupBy === 'flat'
          ? rowsAvailable && runtime.renderView(SESSION_ROWS, rowsContext({ kind: 'flat' }))
          : <div role="tree" aria-label="工作区">
            {nodes.map(node => renderNode(node, 0))}
            {ungrouped && <UngroupedGroup expanded={!view.collapsed[UNGROUPED]} onToggle={() => toggle(UNGROUPED)}
              rows={rowsAvailable ? runtime.renderView(SESSION_ROWS, rowsContext({ kind: 'group', workspaceId: null })) : null} />}
          </div>)}
      {empty && !searching && <div className={styles.emptyState}>
        <QueueIcon />
        <div>暂无工作区</div>
        <div className={styles.emptyHint}>从右上角添加工作区，选择服务器上的一个目录。</div>
      </div>}
    </div>
    {dragging && (() => {
      const workspace = workspaces.find(item => item.id === dragging.workspaceId);
      return workspace ? <div className={styles.ghost} style={{ left: dragging.x + 10, top: dragging.y + 8 }} aria-hidden="true">{workspace.name}</div> : null;
    })()}
    {creating && <DirectoryPicker runtime={runtime} onCancel={() => setCreating(false)} onConfirm={createWorkspace} />}
    {menu && <FileMenu anchor={menu} label="工作区操作" items={menuItems()} dismiss={() => setMenu(undefined)} />}
    {action?.kind === 'rename' && <RenameDialog key={action.workspace.id} runtime={runtime} workspace={action.workspace} workspaces={overview?.workspaces ?? []} close={() => setAction(undefined)} done={refresh} />}
    {action?.kind === 'delete' && <DeleteDialog key={action.workspace.id} runtime={runtime} workspace={action.workspace}
      gone={overview !== undefined && !overview.workspaces.some(item => item.id === action.workspace.id)} close={() => setAction(undefined)}
      // A removed registration leaves the selection unless a Session keeps it there: that Session stays open, now under 未分组.
      done={async () => { await refresh(); if (chosen.workspaceId === action.workspace.id && !chosen.sessionId) select({ workspaceId: null }); }} />}
  </section>;
}

/** The trailing group of Sessions without a Workspace: a folder row that only folds. */
function UngroupedGroup({ expanded, onToggle, rows }: { expanded: boolean; onToggle(): void; rows: ReactNode }) {
  return <div className={styles.groupSection} data-workspace-group={UNGROUPED}>
    <div role="treeitem" aria-expanded={expanded} tabIndex={0} className={styles.projectRow} onClick={onToggle}
      onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ') && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) { event.preventDefault(); onToggle(); } }}>
      <span className={styles.slot}>{expanded ? <FolderOpenIcon /> : <FolderCloseIcon />}</span>
      <span className={`${styles.slot} ${styles.chevron}`}><TriangleRightIcon className={expanded ? styles.arrowOpen : undefined} /></span>
      <span className={styles.projectText}><span className={styles.title}>未分组</span></span>
    </div>
    {expanded && rows}
  </div>;
}

/** One Workspace's header row: folder + title, the chevron it becomes under the pointer, and — on
 * hover, or while its menu is open — its two actions. Clicking the row folds and unfolds the group;
 * right-click and ··· raise the same menu; dwelling shows the hover card. */
function WorkspaceRow({ workspace, expanded, active, dragging, menuOpen, onToggle, onCreate, onMenu, onClick, onPointerDown, onPointerMove, onPointerEnd }: {
  workspace: Workspace; expanded: boolean; active: boolean; dragging: boolean; menuOpen: boolean;
  onToggle(): void; onCreate(): void; onMenu(event: ReactMouseEvent<HTMLElement>): void; onClick(): void;
  onPointerDown(event: ReactPointerEvent<HTMLElement>): void; onPointerMove(event: ReactPointerEvent<HTMLElement>): void; onPointerEnd(): void;
}) {
  const label = workspace.name;
  const row = <div role="treeitem" aria-expanded={expanded} aria-label={label} tabIndex={0} data-row-key={`workspace:${workspace.id}`}
    className={`${styles.projectRow}${menuOpen ? ` ${styles.menuOpen}` : ''}${dragging ? ` ${styles.dragging}` : ''}`}
    onClick={onClick}
    onKeyDown={event => {
      if (event.target !== event.currentTarget) return;
      if ((event.key === 'Enter' || event.key === ' ') && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) { event.preventDefault(); onToggle(); }
      if (event.key === 'ContextMenu') { event.preventDefault(); onMenu(event as unknown as ReactMouseEvent<HTMLElement>); }
    }}
    onContextMenu={event => { event.preventDefault(); onMenu(event); }}
    onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}>
    <span className={`${styles.slot} ${styles.folder}${active ? ` ${styles.folderActive}` : ''}`}>{expanded ? <FolderOpenIcon /> : <FolderCloseIcon />}</span>
    <span className={`${styles.slot} ${styles.chevron}`}><TriangleRightIcon className={expanded ? styles.arrowOpen : undefined} /></span>
    <span className={styles.projectText}><span className={styles.title}>{label}</span></span>
    {/* The strip's clicks stay in the strip: neither button also folds the row. */}
    <span className={styles.rowActions} onClick={event => event.stopPropagation()}>
      <button type="button" className={styles.iconButton} aria-label={`工作区“${label}”的操作`} title="更多操作" onClick={onMenu}><EllipsisIcon /></button>
      <button type="button" className={styles.iconButton} aria-label={`在“${label}”中新建会话`} title="新会话" onClick={onCreate}><NewChatIcon /></button>
    </span>
  </div>;
  return <HoverCard anchor={row} label={`工作区“${label}”`} disabled={menuOpen || dragging} content={<WorkspaceHoverContent workspace={workspace} />} />;
}

function WorkspaceHoverContent({ workspace }: { workspace: Workspace }) {
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = () => void navigator.clipboard.writeText(workspace.directory).then(() => setCopied('copied'), () => setCopied('failed'));
  return <>
    <div className={styles.hoverTitle}>{workspace.name}</div>
    <div className={styles.hoverPath}>{workspace.directory}</div>
    {workspace.createdAt && <div className={styles.hoverTime}>创建于 {createdLabel(workspace.createdAt)}</div>}
    <button type="button" className={styles.hoverCopy} onClick={copy}><CopyIcon />{copied === 'copied' ? '已复制' : copied === 'failed' ? '复制失败，重试' : '复制路径'}</button>
  </>;
}

/** The view-options menu: how the tree groups and how Sessions are ordered. Each choice closes it. */
function ViewOptionsMenu({ view, choose }: { view: NavView; choose(update: Partial<NavView>): void }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<MenuAnchor>();
  const items: readonly MenuItem[] = [
    { id: 'group-by', heading: true, label: '分组方式', run() { /* a label */ } },
    { id: 'group-workspace', label: '按工作区', checked: view.groupBy === 'workspace', icon: <FolderCloseIcon />, run: () => choose({ groupBy: 'workspace' }) },
    { id: 'group-tree', label: '按工作区树', checked: view.groupBy === 'workspace-tree', icon: <WorkspaceTreeIcon />, run: () => choose({ groupBy: 'workspace-tree' }) },
    { id: 'group-flat', label: '单列表', checked: view.groupBy === 'flat', icon: <FlatListIcon />, run: () => choose({ groupBy: 'flat' }) },
    { id: 'order-by', heading: true, label: '排序方式', separatorBefore: true, run() { /* a label */ } },
    { id: 'order-manual', label: '手动排序', checked: view.orderBy === 'manual', icon: <ChevronsUpDownIcon />, run: () => choose({ orderBy: 'manual' }) },
    { id: 'order-updated', label: '最近更新', checked: view.orderBy === 'updated', icon: <ClockIcon />, run: () => choose({ orderBy: 'updated' }) },
  ];
  return <>
    <button ref={trigger} type="button" className={styles.iconButton} aria-label="视图选项" title="视图选项" aria-haspopup="menu" aria-expanded={menu !== undefined}
      onClick={() => { const box = trigger.current!.getBoundingClientRect(); setMenu(menu ? undefined : { x: box.right, y: box.bottom, align: 'end', returnTo: trigger.current! }); }}><SlidersIcon /></button>
    {menu && <FileMenu anchor={menu} label="视图选项" items={items} dismiss={() => setMenu(undefined)} />}
  </>;
}

/** dsh's dialog family for both Workspace actions: a 380px card, a 16px title, right-aligned actions. */
function Dialog({ title, description, busy, close, children }: { title: string; description?: string; busy: boolean; close(): void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const before = document.activeElement as HTMLElement | null; dialog.current?.showModal(); return () => { dialog.current?.close(); if (before?.isConnected) before.focus(); } }, []);
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby="workspace-dialog-title" onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
    <h2 id="workspace-dialog-title">{title}</h2>
    {description && <p className={styles.dialogDescription}>{description}</p>}
    {children}
  </dialog>;
}

/** Rename: the input opens on the shown name, selected; confirming is blocked while the name is
 * blank, unchanged, or another Workspace's — the last with its message in place. */
function RenameDialog({ runtime, workspace, workspaces, close, done }: { runtime: UiRuntime; workspace: Workspace; workspaces: readonly Workspace[]; close(): void; done(): void }) {
  const [draft, setDraft] = useState(workspace.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const composing = useRef(false);
  // One command identity per draft: a lost response replays the receipt instead of renaming twice.
  const attempt = useRef({ draft: workspace.name, commandId: crypto.randomUUID() });
  const trimmed = draft.trim();
  // Self is excluded by identity, not by title: the draft starts as this Workspace's own name.
  const duplicate = trimmed !== '' && workspaces.some(item => item.id !== workspace.id && item.name === trimmed);
  const blocked = busy || trimmed === '' || trimmed === workspace.name || duplicate;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (blocked) return;
    if (attempt.current.draft !== trimmed) attempt.current = { draft: trimmed, commandId: crypto.randomUUID() };
    setBusy(true); setError('');
    try { await runtime.command<CommandReceipt<Workspace>>('workspace.rename', { id: workspace.id, name: trimmed }, attempt.current.commandId, { version: 1 }); close(); done(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '重命名结果未确认，可重试'); }
    finally { setBusy(false); }
  };
  return <Dialog title="重命名工作区" busy={busy} close={close}>
    <form className={styles.dialogForm} onSubmit={event => void submit(event)}>
      <input className={styles.dialogInput} aria-label="工作区名称" autoFocus onFocus={event => event.target.select()} maxLength={120} value={draft} disabled={busy}
        onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
        onChange={event => { setDraft(event.target.value); setError(''); }} />
      {duplicate && <p role="alert" className={styles.dialogError}>{`已存在名为“${trimmed}”的工作区。`}</p>}
      {error && <p role="alert" className={styles.dialogError}>{error}</p>}
      <footer className={styles.dialogFooter}>
        <button type="button" disabled={busy} onClick={close}>取消</button>
        <button type="submit" className={styles.primary} disabled={blocked}>{busy ? '正在保存…' : '重命名'}</button>
      </footer>
    </form>
  </Dialog>;
}

/** Delete: the confirmation names the Workspace and states the retention boundary; its button is the
 * destructive colour. The dialog stays until the list has dropped the Workspace, so no stale frame
 * shows it after the confirmation closed. */
function DeleteDialog({ runtime, workspace, gone, close, done }: { runtime: UiRuntime; workspace: Workspace; gone: boolean; close(): void; done(): void }) {
  const [busy, setBusy] = useState(false);
  const [committed, setCommitted] = useState(false);
  const [error, setError] = useState('');
  const commandId = useRef(crypto.randomUUID());
  useEffect(() => {
    if (!committed) return;
    if (gone) { close(); return; }
    // A list that never reflects the deletion must not hold the dialog: the receipt already confirmed it.
    const timer = setTimeout(close, 2000);
    return () => clearTimeout(timer);
  }, [committed, gone]);
  const confirm = async () => {
    setBusy(true); setError('');
    try { await runtime.command<CommandReceipt<Workspace>>('workspace.delete', { id: workspace.id }, commandId.current, { version: 1 }); setCommitted(true); done(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '删除结果未确认，可重试'); }
    finally { setBusy(false); }
  };
  return <Dialog title="删除工作区" description={`将把“${workspace.name}”从工作区列表中移除。文件夹与会话记录会保留，其会话将显示在“未分组”下。`} busy={busy} close={close}>
    <div className={styles.dialogForm}>
      {busy && <p role="status" className={styles.dialogStatus}>正在删除工作区…</p>}
      {error && <p role="alert" className={styles.dialogError}>{error}</p>}
      <footer className={styles.dialogFooter}>
        <button type="button" disabled={busy} onClick={close}>取消</button>
        <button type="button" className={styles.danger} disabled={busy} onClick={() => void confirm()}>{busy ? '正在删除…' : '删除工作区'}</button>
      </footer>
    </div>
  </Dialog>;
}
