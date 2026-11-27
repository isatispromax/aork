import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { UiRuntime } from '@aork/sdk/client';
import type { CommandReceipt } from '@aork/sdk/durable';
import { readWorkbenchSelection, withWorkbenchSelection, workspaceOverviewSchema } from '@aork/contracts/workspace';
import type { WorkspaceOverview } from '@aork/contracts/workspace';
import { pendingIndexSchema, type PendingIndex } from '@aork/contracts/interaction';
import { unreadPageSchema, type UnreadPage } from '@aork/contracts/workbench';
import { reorderSchema, renameSessionSchema, sessionsProjectionSchema, setPinSchema } from '@aork/contracts/session';
import type { Session, SessionsProjection } from '@aork/contracts/session';
import { HandoffModalHost } from './handoff.js';
import styles from './session-browser.module.css';

/** dsh-style session browser: workspace groups or one flat list, recency or manual
 * drag ordering, pinning, rename, search and per-group watermark pagination. There
 * is deliberately no archive entry anywhere in this surface. */

type GroupBy = 'workspace' | 'flat';
type OrderBy = 'updated' | 'manual';
interface ViewOptions { groupBy: GroupBy; orderBy: OrderBy }
const VIEW_STORE = 'aork.sessions.view.v1';
const WATERMARK_BASE = 5;

function loadViewOptions(): ViewOptions {
  try {
    const parsed = JSON.parse(localStorage.getItem(VIEW_STORE) ?? '') as Partial<ViewOptions>;
    return { groupBy: parsed.groupBy === 'flat' ? 'flat' : 'workspace', orderBy: parsed.orderBy === 'manual' ? 'manual' : 'updated' };
  } catch { return { groupBy: 'workspace', orderBy: 'updated' }; }
}

function relativeTime(iso: string | undefined, fallback: string): string {
  const time = Date.parse(iso ?? fallback);
  if (Number.isNaN(time)) return '';
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  return (iso ?? fallback).slice(0, 10);
}

type RowStatus = 'pending' | 'running' | 'unread' | 'failed';
const statusLabel: Record<RowStatus, string> = { pending: '有待处理交互', running: '运行中', unread: '有未读回复', failed: '最近一轮执行失败' };

/** Projection rows omit the environments join; the browser reads none of it. */
type ProjectionEntry = SessionsProjection['sessions'][number];

function rowStatus(entry: ProjectionEntry, pending: PendingIndex | undefined, unread: UnreadPage | undefined): RowStatus | undefined {
  const sessionId = entry.session.id;
  if (pending?.items.some(item => item.sessionId === sessionId)) return 'pending';
  if (entry.execution.state === 'starting' || (entry.currentTurn && ['dispatching', 'running', 'cancelling'].includes(entry.currentTurn.state))) return 'running';
  if (unread?.items.some(item => item.sessionId === sessionId)) return 'unread';
  if (entry.currentTurn?.state === 'failed') return 'failed';
  return undefined;
}

interface BrowserGroup { key: string; title: string; workspaceId: string | null; sessions: ProjectionEntry[] }

export function SessionBrowser({ runtime }: { runtime: UiRuntime }) {
  const [projection, setProjection] = useState<SessionsProjection>();
  const [workspaces, setWorkspaces] = useState<WorkspaceOverview>();
  const [pending, setPending] = useState<PendingIndex>();
  const [unread, setUnread] = useState<UnreadPage>();
  const [error, setError] = useState('');
  const [view, setView] = useState<ViewOptions>(loadViewOptions);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [limits, setLimits] = useState<Record<string, number>>({});
  const [renaming, setRenaming] = useState<Session | undefined>();
  const [handoffFor, setHandoffFor] = useState<string | undefined>();
  const [dragging, setDragging] = useState<{ sessionId: string; x: number; y: number; overId: string | undefined } | undefined>();
  const [chosen, setChosen] = useState(readWorkbenchSelection(location.hash));
  useEffect(() => { const change = () => setChosen(readWorkbenchSelection(location.hash)); addEventListener('hashchange', change); return () => removeEventListener('hashchange', change); }, []);
  useEffect(() => { let active = true;
    const stop = runtime.observeSnapshot<SessionsProjection>('sessions.overview', {}, {
      next(value) { if (active) { setProjection(sessionsProjectionSchema.parse(value)); setError(''); } },
      error(failure) { if (active) setError(failure.message); },
    }, { owners: ['sessions'] });
    return () => { active = false; void stop(); };
  }, [runtime]);
  useEffect(() => { let active = true;
    const stop = runtime.subscribe<WorkspaceOverview>('workspace.overview', { next(value) { if (active) setWorkspaces(workspaceOverviewSchema.parse(value)); }, error() {} }, { intervalMs: 1000 });
    return () => { active = false; void stop(); };
  }, [runtime]);
  useEffect(() => { let active = true;
    const stop = runtime.observeSnapshot<PendingIndex>('interactions.pendingIndex', {}, { next(value) { if (active) setPending(pendingIndexSchema.parse(value)); }, error() {} }, { owners: ['interactions'] });
    return () => { active = false; void stop(); };
  }, [runtime]);
  useEffect(() => { let active = true;
    const stop = runtime.observeSnapshot<UnreadPage>('workbench.unread', {}, { next(value) { if (active) setUnread(unreadPageSchema.parse(value)); }, error() {} }, { owners: ['workbench'] });
    return () => { active = false; void stop(); };
  }, [runtime]);
  function updateView(update: Partial<ViewOptions>) {
    setView(current => {
      const next = { ...current, ...update };
      try { localStorage.setItem(VIEW_STORE, JSON.stringify(next)); } catch { /* presentation-only */ }
      return next;
    });
  }
  const entries = useMemo(() => projection?.sessions ?? [], [projection]);
  const workspaceName = (id: string) => workspaces?.workspaces.find(item => item.id === id)?.name ?? '未知工作区';
  const needle = query.trim().toLowerCase();
  const ordered = useMemo(() => {
    const compare = (a: ProjectionEntry, b: ProjectionEntry) => {
      if (Boolean(a.session.pinned) !== Boolean(b.session.pinned)) return a.session.pinned ? -1 : 1;
      if (view.orderBy === 'manual') {
        const left = a.session.order ?? Number.MAX_SAFE_INTEGER;
        const right = b.session.order ?? Number.MAX_SAFE_INTEGER;
        if (left !== right) return left - right;
        return a.session.name.localeCompare(b.session.name);
      }
      return Date.parse(b.session.updatedAt ?? b.session.createdAt) - Date.parse(a.session.updatedAt ?? a.session.createdAt);
    };
    return entries
      .filter(entry => !needle || entry.session.name.toLowerCase().includes(needle) || workspaceName(entry.session.workspaceId).toLowerCase().includes(needle) || entry.session.id.toLowerCase().includes(needle))
      .sort(compare);
  }, [entries, view.orderBy, needle, workspaces]);
  const groups = useMemo<BrowserGroup[]>(() => {
    if (needle || view.groupBy === 'flat') return ordered.length ? [{ key: '', title: '全部会话', workspaceId: null, sessions: ordered }] : [];
    const buckets = new Map<string, ProjectionEntry[]>();
    for (const entry of ordered) {
      const list = buckets.get(entry.session.workspaceId) ?? [];
      list.push(entry);
      buckets.set(entry.session.workspaceId, list);
    }
    const names = new Map((workspaces?.workspaces ?? []).map(item => [item.id, item.name]));
    return [...buckets.entries()].map(([workspaceId, sessions]) => ({ key: workspaceId, title: names.get(workspaceId) ?? '未知工作区', workspaceId, sessions }));
  }, [ordered, view.groupBy, needle, workspaces]);
  function select(sessionId: string, workspaceId: string) {
    location.hash = withWorkbenchSelection(location.hash, { workspaceId, sessionId, creatingSession: false });
  }
  function createIn(workspaceId: string | null) {
    location.hash = withWorkbenchSelection(location.hash, { workspaceId, sessionId: null, creatingSession: true });
  }
  async function setPinned(entry: ProjectionEntry, pinned: boolean) {
    try { await runtime.command<CommandReceipt<Session>>('sessions.setPin', { id: entry.session.id, pinned }, crypto.randomUUID(), { version: 1 }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '置顶结果未确认'); }
  }
  async function commitOrder(workspaceId: string, orderedIds: string[]) {
    try {
      await runtime.command('sessions.reorder', { workspaceId, orderedIds }, crypto.randomUUID(), { version: 1 });
      updateView({ orderBy: 'manual' });
    } catch (failure) { setError(failure instanceof Error ? failure.message : '排序结果未确认，可重试'); }
  }
  // Pointer-based group-local drag reordering; a drag switches the view to manual order.
  const dragGesture = useRef<{ sessionId: string; workspaceId: string; startX: number; startY: number; active: boolean }>(null);
  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => {
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-session-row]');
      setDragging(current => current ? { ...current, x: event.clientX, y: event.clientY, overId: target?.dataset.sessionRow ?? undefined } : current);
    };
    const up = (event: PointerEvent) => {
      setDragging(current => {
        if (current) {
          const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-session-row]');
          const overId = target?.dataset.sessionRow ?? undefined;
          const group = groups.find(item => item.sessions.some(candidate => candidate.session.id === overId));
          if (overId && overId !== current.sessionId && group && group.workspaceId) {
            const ids = group.sessions.map(item => item.session.id).filter(id => id !== current.sessionId);
            const index = ids.indexOf(overId);
            ids.splice(index < 0 ? ids.length : index, 0, current.sessionId);
            void commitOrder(group.workspaceId, ids);
          }
        }
        return undefined;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
  }, [dragging, groups]);
  function rowPointerDown(event: ReactPointerEvent<HTMLElement>, entry: ProjectionEntry) {
    if (!event.isPrimary || event.button !== 0 || !(event.target instanceof HTMLElement) || event.target.closest('button')) return;
    dragGesture.current = { sessionId: entry.session.id, workspaceId: entry.session.workspaceId, startX: event.clientX, startY: event.clientY, active: false };
  }
  function rowPointerMove(event: ReactPointerEvent<HTMLElement>) {
    const gesture = dragGesture.current;
    if (!gesture || dragging) return;
    if (!gesture.active && Math.abs(event.clientX - gesture.startX) < 6 && Math.abs(event.clientY - gesture.startY) < 6) return;
    gesture.active = true;
    setDragging({ sessionId: gesture.sessionId, x: event.clientX, y: event.clientY, overId: undefined });
  }
  function rowPointerEnd() { dragGesture.current = null; }
  return <section className={styles.browser} aria-label="会话导航">
    <header className={styles.header}>
      <h2 className={styles.heading}>会话</h2>
      {searchOpen && <input autoFocus className={styles.search} type="search" placeholder="搜索会话、工作区" aria-label="搜索会话" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { setQuery(''); setSearchOpen(false); } }} />}
      <button type="button" className={styles.headerButton} aria-label="搜索会话" aria-pressed={searchOpen} title="搜索会话" onClick={() => { setSearchOpen(value => !value); setQuery(''); }}>⌕</button>
      <details className={styles.viewOptions}>
        <summary className={styles.headerButton} aria-label="视图选项" title="视图选项">⋮</summary>
        <div className={styles.viewMenu} role="menu">
          <p>分组</p>
          {(['workspace', 'flat'] as const).map(value => <button key={value} type="button" role="menuitemradio" aria-checked={view.groupBy === value} onClick={() => updateView({ groupBy: value })}>{value === 'workspace' ? '按工作区分组' : '平铺列表'}</button>)}
          <p>排序</p>
          {(['updated', 'manual'] as const).map(value => <button key={value} type="button" role="menuitemradio" aria-checked={view.orderBy === value} onClick={() => updateView({ orderBy: value })}>{value === 'updated' ? '最近更新' : '手动排序'}</button>)}
        </div>
      </details>
    </header>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {!projection && !error && <p role="status" className={styles.empty}>正在读取会话…</p>}
    {projection && !groups.length && <p className={styles.empty}>{needle ? '没有匹配的会话。' : '创建一个会话，开始与 Agent 协作。'}</p>}
    {groups.map(group => {
      // Watermark pagination: status-relevant rows always stay visible (dsh rule).
      const forcedIndex = group.sessions.reduce((last, entry, index) => {
        const status = rowStatus(entry, pending, unread);
        return status || entry.session.id === chosen.sessionId ? Math.max(last, index) : last;
      }, -1);
      const userLimit = limits[group.key] ?? WATERMARK_BASE;
      const limit = Math.max(userLimit, forcedIndex + 1);
      const visible = group.sessions.slice(0, limit);
      return <div key={group.key || 'flat'} className={styles.group}>
        {view.groupBy === 'workspace' && !needle && <div className={styles.groupHeader}>
          <strong>{group.title}</strong>
          <span className={styles.groupCount}>{group.sessions.length}</span>
          <button type="button" className={styles.groupCreate} aria-label={`在 ${group.title} 中新建会话`} title="在此工作区新建会话" onClick={() => createIn(group.workspaceId)}>＋</button>
        </div>}
        <ol className={styles.rows}>
          {visible.map(entry => <Row key={entry.session.id} entry={entry} status={rowStatus(entry, pending, unread)}
            time={relativeTime(entry.session.updatedAt, entry.session.createdAt)}
            selected={entry.session.id === chosen.sessionId}
            dragging={dragging?.sessionId === entry.session.id ? dragging : undefined}
            onPointerDown={event => rowPointerDown(event, entry)} onPointerMove={rowPointerMove} onPointerEnd={rowPointerEnd}
            onSelect={() => select(entry.session.id, entry.session.workspaceId)}
            onPin={() => void setPinned(entry, !entry.session.pinned)}
            onRename={() => setRenaming(entry.session)}
            onHandoff={() => setHandoffFor(entry.session.id)} />)}
        </ol>
        {group.sessions.length > visible.length && <button type="button" className={styles.watermark} onClick={() => setLimits(current => ({ ...current, [group.key]: group.sessions.length }))}>
          显示更多（还有 {group.sessions.length - visible.length} 个）
        </button>}
        {group.sessions.length === visible.length && userLimit > WATERMARK_BASE && <button type="button" className={styles.watermark} onClick={() => setLimits(current => ({ ...current, [group.key]: WATERMARK_BASE }))}>收起</button>}
      </div>;
    })}
    {dragging && (() => {
      const entry = ordered.find(item => item.session.id === dragging.sessionId);
      return entry ? <div className={styles.dragGhost} style={{ left: dragging.x + 10, top: dragging.y + 8 }}>{entry.session.name}</div> : null;
    })()}
    {renaming && <RenameDialog runtime={runtime} session={renaming} close={() => setRenaming(undefined)} />}
    {handoffFor && <HandoffModalHost runtime={runtime} sourceSessionId={handoffFor} close={() => setHandoffFor(undefined)} busy={false} />}
  </section>;
}

function Row({ entry, status, time, selected, dragging, onSelect, onPin, onRename, onHandoff, onPointerDown, onPointerMove, onPointerEnd }: {
  entry: ProjectionEntry;
  status: RowStatus | undefined;
  time: string;
  selected: boolean;
  dragging: { overId: string | undefined } | undefined;
  onSelect(): void;
  onPin(): void;
  onRename(): void;
  onHandoff(): void;
  onPointerDown(event: ReactPointerEvent<HTMLElement>): void;
  onPointerMove(event: ReactPointerEvent<HTMLElement>): void;
  onPointerEnd(): void;
}): ReactNode {
  const label = status ? statusLabel[status] : undefined;
  return <li className={`${styles.row}${dragging ? ` ${styles.rowDragging}` : ''}${dragging?.overId === entry.session.id ? ` ${styles.rowOver}` : ''}`} data-session-row={entry.session.id}
    onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}>
    <button type="button" className={styles.rowMain} aria-label={entry.session.name} aria-current={selected ? 'page' : undefined} title={entry.session.name} onClick={onSelect}>
      <span className={`${styles.dot}${status ? ` ${styles[status]}` : ''}`} aria-hidden="true" />
      <span className={styles.rowTitle}>{entry.session.pinned && <span aria-hidden="true" className={styles.pin}>▪</span>}{entry.session.name}</span>
      <span className={styles.rowTime}>{time}</span>
    </button>
    <span className={styles.rowActions}>
      {label && <span className={styles.statusLabel}>{label}</span>}
      <button type="button" className={styles.rowAction} aria-label={entry.session.pinned ? `取消置顶 ${entry.session.name}` : `置顶 ${entry.session.name}`} title={entry.session.pinned ? '取消置顶' : '置顶'} onClick={onPin}>{entry.session.pinned ? '◈' : '◇'}</button>
      <button type="button" className={styles.rowAction} aria-label={`重命名 ${entry.session.name}`} title="重命名" onClick={onRename}>✎</button>
      <button type="button" className={styles.rowAction} aria-label={`交接到新会话（${entry.session.name}）`} title="交接到新会话" onClick={onHandoff}>⇄</button>
    </span>
  </li>;
}

function RenameDialog({ runtime, session, close }: { runtime: UiRuntime; session: Session; close(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(session.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { const before = document.activeElement as HTMLElement | null; dialog.current?.showModal(); return () => { dialog.current?.close(); before?.focus(); }; }, []);
  async function submit() {
    if (busy || !name.trim()) return;
    setBusy(true); setError('');
    try {
      await runtime.command<CommandReceipt<Session>>('sessions.rename', { id: session.id, name: name.trim() }, crypto.randomUUID(), { version: 1 });
      close();
    } catch (failure) { setError(failure instanceof Error ? failure.message : '重命名结果未确认，可重试'); } finally { setBusy(false); }
  }
  return <dialog ref={dialog} className={styles.dialog} aria-label="重命名会话" onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
    <form onSubmit={event => { event.preventDefault(); void submit(); }}>
      <h2>重命名会话</h2>
      <label>会话名称<input autoFocus required maxLength={120} value={name} onChange={event => setName(event.target.value)} onFocus={event => event.target.select()} /></label>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      <footer><button type="button" disabled={busy} onClick={close}>取消</button><button type="submit" disabled={busy || !name.trim() || name.trim() === session.name}>{busy ? '正在保存…' : '保存'}</button></footer>
    </form>
  </dialog>;
}
