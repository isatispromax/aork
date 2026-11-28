import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { UiRuntime, ViewProps } from '@aork/sdk/client';
import type { CommandReceipt } from '@aork/sdk/durable';
import { readWorkbenchSelection, withWorkbenchSelection } from '@aork/contracts/workspace';
import type { Session, SessionRowsContext, SessionsProjection } from '@aork/contracts/session';
import { HandoffModalHost } from './handoff.js';
import { RowMenu } from './row-menu.js';
import type { MenuAnchor, MenuItem } from './row-menu.js';
import { useBrowserData } from './browser-data.js';
import { EllipsisIcon, PinIcon } from './icons.js';
import styles from './session-rows.module.css';

/** The Session rows of the Workspace browser (`aork.workspace.navigation@1`), in the shape of
 * deepseek-harness's ui-workspace: the browser owns the tree and draws the Workspace rows; this view
 * draws what sits under one of them — status dot, title, time or pending label, pin marker and a
 * ··· menu — or the single flat list, or the search results. One instance per group, so a group's
 * watermark, drag and dialogs die with it when the group folds. */

/** Non-status rows visible per group until the user asks for more. */
const WATERMARK_BASE = 5;
/** Search shows its best matches first and stops here; the query narrows the rest. */
const SEARCH_LIMIT = 20;

type ProjectionEntry = SessionsProjection['sessions'][number];
type RowStatus = 'pending' | 'running' | 'unread' | 'failed';
const statusLabel: Record<RowStatus, string> = { pending: '有待处理交互', running: '运行中', unread: '有未读回复', failed: '最近一轮执行失败' };

function rowStatus(entry: ProjectionEntry, pending: { items: ReadonlyArray<{ sessionId: string }> } | undefined, unread: { items: ReadonlyArray<{ sessionId: string }> } | undefined): RowStatus | undefined {
  const sessionId = entry.session.id;
  if (pending?.items.some(item => item.sessionId === sessionId)) return 'pending';
  if (entry.execution.state === 'starting' || (entry.currentTurn && ['dispatching', 'running', 'cancelling'].includes(entry.currentTurn.state))) return 'running';
  if (unread?.items.some(item => item.sessionId === sessionId)) return 'unread';
  if (entry.currentTurn?.state === 'failed') return 'failed';
  return undefined;
}

/** dsh's compact relative time: 刚刚, then a count and its unit, without "ago". */
export function relativeTime(iso: string | undefined, fallback: string, now: number): string {
  const time = Date.parse(iso ?? fallback);
  if (Number.isNaN(time)) return '';
  const minutes = Math.round((now - time) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} 个月`;
  return `${Math.round(months / 12)} 年`;
}

/** A row drag in flight: the row, the ghost's position and the row the insertion marker sits on. */
interface Drag { sessionId: string; x: number; y: number; over: { id: string; half: 'before' | 'after' } | undefined }

export function SessionRows({ runtime, context }: ViewProps): ReactNode {
  const ctx = context as SessionRowsContext | undefined;
  if (!ctx || !ctx.scope) return null;
  return <Rows runtime={runtime} ctx={ctx} />;
}

function Rows({ runtime, ctx }: { runtime: UiRuntime; ctx: SessionRowsContext }) {
  const data = useBrowserData(runtime);
  const [chosen, setChosen] = useState(readWorkbenchSelection(location.hash));
  useEffect(() => { const change = () => setChosen(readWorkbenchSelection(location.hash)); addEventListener('hashchange', change); return () => removeEventListener('hashchange', change); }, []);
  const [watermark, setWatermark] = useState(WATERMARK_BASE);
  const [renaming, setRenaming] = useState<Session>();
  const [handoffFor, setHandoffFor] = useState<string>();
  const [menu, setMenu] = useState<MenuAnchor>();
  const menuFor = useRef<ProjectionEntry | undefined>(undefined);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState<Drag>();
  const list = useRef<HTMLOListElement>(null);
  const scope = ctx.scope;
  const search = scope.kind === 'search';
  const groupWorkspaceId = scope.kind === 'group' ? scope.workspaceId : undefined;
  const registered = useMemo(() => new Set(data.workspaces?.workspaces.map(item => item.id)), [data.workspaces]);
  const workspaceName = (id: string) => data.workspaces?.workspaces.find(item => item.id === id)?.name ?? '未分组';
  const needle = search ? scope.query.trim().toLowerCase() : '';
  const now = Date.now();
  const rows = useMemo(() => {
    const compare = (a: ProjectionEntry, b: ProjectionEntry) => {
      if (Boolean(a.session.pinned) !== Boolean(b.session.pinned)) return a.session.pinned ? -1 : 1;
      if (ctx.orderBy === 'manual') {
        // Saved positions lead; Sessions never dragged follow by recency, newest first.
        const left = a.session.order ?? Number.MAX_SAFE_INTEGER; const right = b.session.order ?? Number.MAX_SAFE_INTEGER;
        if (left !== right) return left - right;
      }
      return Date.parse(b.session.updatedAt ?? b.session.createdAt) - Date.parse(a.session.updatedAt ?? a.session.createdAt);
    };
    return (data.projection?.sessions ?? []).filter((entry) => {
      if (scope.kind === 'group') {
        // Until the Workspace list lands nothing is known to be ungrouped: the bucket waits for it.
        if (scope.workspaceId === null) return data.workspaces !== undefined && !registered.has(entry.session.workspaceId);
        return entry.session.workspaceId === scope.workspaceId;
      }
      if (scope.kind === 'flat') return true;
      return entry.session.name.toLowerCase().includes(needle) || entry.session.id.toLowerCase().includes(needle) || workspaceName(entry.session.workspaceId).toLowerCase().includes(needle);
    }).sort(compare);
  }, [data.projection, data.workspaces, registered, scope, ctx.orderBy]);
  // Rows that need attention, the shown Session and a revealed one are never below the watermark.
  const forced = rows.reduce((last, entry, index) => rowStatus(entry, data.pending, data.unread) || entry.session.id === chosen.sessionId || entry.session.id === ctx.revealSessionId ? Math.max(last, index) : last, -1);
  const limit = search ? SEARCH_LIMIT : Math.max(watermark, forced + 1);
  const visible = rows.slice(0, limit);
  useEffect(() => {
    const id = ctx.revealSessionId;
    if (!id) return;
    const node = list.current?.querySelector<HTMLElement>(`[data-session-row="${id}"]`);
    if (!node) return;
    node.scrollIntoView({ block: 'nearest' });
    ctx.onRevealed?.(id);
  }, [ctx.revealSessionId, ctx.onRevealed, limit, rows.length]);
  function select(entry: ProjectionEntry) {
    location.hash = withWorkbenchSelection(location.hash, { workspaceId: entry.session.workspaceId, sessionId: entry.session.id, creatingSession: false });
  }
  function menuItems(): readonly MenuItem[] {
    const entry = menuFor.current;
    if (!entry) return [];
    const pinned = Boolean(entry.session.pinned);
    return [
      { id: 'pin', label: pinned ? '取消置顶' : '置顶', run: () => void setPinned(entry, !pinned) },
      { id: 'rename', label: '重命名…', run: () => setRenaming(entry.session) },
      { id: 'copy-id', label: '复制会话 ID', separatorBefore: true, run: () => { void navigator.clipboard.writeText(entry.session.id).catch(() => setError('复制失败，请重试')); } },
      { id: 'handoff', label: '交接到新会话…', run: () => setHandoffFor(entry.session.id) },
    ];
  }
  async function setPinned(entry: ProjectionEntry, pinned: boolean) {
    try { await runtime.command<CommandReceipt<Session>>('sessions.setPin', { id: entry.session.id, pinned }, crypto.randomUUID(), { version: 1 }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '置顶结果未确认'); }
  }
  async function commitOrder(workspaceId: string, orderedIds: string[]) {
    try {
      await runtime.command('sessions.reorder', { workspaceId, orderedIds }, crypto.randomUUID(), { version: 1 });
      ctx.onManualOrder();
    } catch (failure) { setError(failure instanceof Error ? failure.message : '排序结果未确认，可重试'); }
  }
  /** The row under the pointer and which of its halves — above or below it — the pointer is in. */
  const rowAt = (x: number, y: number): Drag['over'] => {
    const target = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-session-row]');
    if (!target || !list.current?.contains(target)) return undefined;
    const rect = target.getBoundingClientRect();
    return { id: target.dataset.sessionRow!, half: y < rect.top + rect.height / 2 ? 'before' : 'after' };
  };
  // Pointer drag inside this list only: a Session reorders within its group, and a drag selects manual order.
  const gesture = useRef<{ sessionId: string; startX: number; startY: number; active: boolean } | null>(null);
  const canDrag = typeof groupWorkspaceId === 'string';
  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => setDragging(current => current ? { ...current, x: event.clientX, y: event.clientY, over: rowAt(event.clientX, event.clientY) } : current);
    const up = (event: PointerEvent) => setDragging(current => {
      const over = rowAt(event.clientX, event.clientY);
      if (current && groupWorkspaceId && over && over.id !== current.sessionId) {
        const ids = rows.map(item => item.session.id).filter(id => id !== current.sessionId);
        const at = ids.indexOf(over.id) + (over.half === 'after' ? 1 : 0);
        commitOrder(groupWorkspaceId, [...ids.slice(0, at), current.sessionId, ...ids.slice(at)]);
      }
      return undefined;
    });
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); };
  }, [dragging, rows, canDrag, groupWorkspaceId]);
  function rowPointerDown(event: ReactPointerEvent<HTMLElement>, entry: ProjectionEntry) {
    if (!event.isPrimary || event.button !== 0 || !(event.target instanceof HTMLElement)) return;
    // The row body drags; a press that begins on the ··· button does not.
    if (event.target.closest('button')) return;
    if (canDrag) gesture.current = { sessionId: entry.session.id, startX: event.clientX, startY: event.clientY, active: false };
  }
  function rowPointerMove(event: ReactPointerEvent<HTMLElement>) {
    const start = gesture.current;
    if (!start || dragging) return;
    if (Math.abs(event.clientX - start.startX) < 6 && Math.abs(event.clientY - start.startY) < 6) return;
    gesture.current = null;
    setDragging({ sessionId: start.sessionId, x: event.clientX, y: event.clientY, over: undefined });
  }
  function rowPointerEnd() { gesture.current = null; }
  const openMenu = (event: ReactMouseEvent<HTMLElement>, entry: ProjectionEntry) => {
    const trigger = event.currentTarget;
    const box = trigger.getBoundingClientRect();
    menuFor.current = entry;
    setMenu({ x: box.right, y: box.bottom, align: 'end', returnTo: trigger });
  };
  const label = scope.kind === 'search' ? '搜索结果' : scope.kind === 'flat' ? '会话' : `会话 · ${scope.workspaceId === null ? '未分组' : workspaceName(scope.workspaceId)}`;
  return <div className={styles.root} style={{ '--rows-indent': `${ctx.depth * 12}px` } as CSSProperties} data-session-rows={scope.kind}>
    {(search || scope.kind === 'flat') && (data.error || error) && <p role="alert" className={styles.error}>{data.error || error}</p>}
    <ol ref={list} className={styles.rows} role="group" aria-label={label}>
      {visible.map(entry => {
        const status = rowStatus(entry, data.pending, data.unread);
        const selected = entry.session.id === chosen.sessionId;
        const menuOpen = menu !== undefined && menuFor.current?.session.id === entry.session.id;
        return search
          ? <li key={entry.session.id} role="treeitem" aria-selected={selected} aria-label={entry.session.name} data-session-row={entry.session.id} data-row-key={`session:${entry.session.id}`} tabIndex={0}
              className={`${styles.searchRow}${selected ? ` ${styles.selected}` : ''}`} onClick={() => select(entry)}
              onKeyDown={event => openOnEnter(event, () => select(entry))}>
            <span className={styles.searchHeading}>
              <span className={styles.slot}>{status && <StatusDot status={status} label={statusLabel[status]} />}</span>
              <span className={styles.searchTitle}>{entry.session.name}</span>
            </span>
            <span className={styles.searchMeta}><span className={styles.searchWorkspace}>{workspaceName(entry.session.workspaceId)}</span></span>
          </li>
          : <li key={entry.session.id} role="treeitem" aria-selected={selected} aria-label={entry.session.name} data-session-row={entry.session.id} data-row-key={`session:${entry.session.id}`} tabIndex={0}
              className={`${styles.row}${selected ? ` ${styles.selected}` : ''}${menuOpen ? ` ${styles.menuOpen}` : ''}${dragging?.sessionId === entry.session.id ? ` ${styles.dragging}` : ''}${dragging?.over?.id === entry.session.id ? ` ${dragging.over.half === 'before' ? styles.dropBefore : styles.dropAfter}` : ''}`}
              onClick={() => select(entry)} onKeyDown={event => openOnEnter(event, () => select(entry))}
              onContextMenu={event => { event.preventDefault(); openMenu(event, entry); }}
              onPointerDown={event => rowPointerDown(event, entry)} onPointerMove={rowPointerMove} onPointerUp={rowPointerEnd} onPointerCancel={rowPointerEnd}>
            <span className={styles.slot}>{status && <StatusDot status={status} label={statusLabel[status]} />}</span>
            <span className={styles.title} title={entry.session.name}>{entry.session.name}</span>
            <span className={styles.resting}>
              <span className={styles.time} aria-hidden={status === 'pending' ? true : undefined}>{status === 'pending' ? '待处理' : relativeTime(entry.session.updatedAt, entry.session.createdAt, now)}</span>
              {entry.session.pinned && <span className={styles.pin} role="img" aria-label="已置顶"><PinIcon /></span>}
            </span>
            <span className={styles.actions} onClick={stop}>
              <button type="button" className={styles.iconButton} aria-label={`会话“${entry.session.name}”的操作`} title="更多操作" onClick={event => openMenu(event, entry)}><EllipsisIcon /></button>
            </span>
          </li>;
      })}
    </ol>
    {rows.length > visible.length && !search && <button type="button" className={styles.watermark} aria-expanded={false} onClick={() => setWatermark(current => {
      const remaining = rows.length - visible.length;
      return remaining <= 5 ? rows.length : Math.min(rows.length, Math.max(current, limit) + 5);
    })}>展开其余 {rows.length - visible.length} 个会话</button>}
    {!search && rows.length === visible.length && watermark > WATERMARK_BASE && <button type="button" className={styles.watermark} aria-expanded={true} onClick={() => setWatermark(WATERMARK_BASE)}>收起</button>}
    {search && !rows.length && <p className={styles.empty}>无匹配会话</p>}
    {search && rows.length > visible.length && <p className={styles.limit}>仅显示前 {visible.length} 条结果，请缩小搜索范围。</p>}
    {dragging && (() => {
      const entry = rows.find(item => item.session.id === dragging.sessionId);
      return entry ? <div className={styles.ghost} style={{ left: dragging.x + 10, top: dragging.y + 8 }} aria-hidden="true">{entry.session.name}</div> : null;
    })()}
    {menu && <RowMenu anchor={menu} label="会话操作" items={menuItems()} dismiss={() => setMenu(undefined)} />}
    {renaming && <RenameDialog runtime={runtime} session={renaming} close={() => setRenaming(undefined)} />}
    {handoffFor && <HandoffModalHost runtime={runtime} sourceSessionId={handoffFor} close={() => setHandoffFor(undefined)} busy={false} />}
  </div>;
}

function openOnEnter(event: ReactKeyboardEvent<HTMLElement>, open: () => void): void {
  if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  event.preventDefault();
  open();
}

/** The strip's clicks stay in the strip: the ··· button acts without also opening the row. */
const stop = (event: ReactMouseEvent<HTMLElement>) => event.stopPropagation();

function StatusDot({ status, label }: { status: RowStatus; label: string }) {
  return <><span aria-hidden="true" className={`${styles.dot} ${styles[status]}`} /><span className={styles.hidden}>{label}</span></>;
}

function RenameDialog({ runtime, session, close }: { runtime: UiRuntime; session: Session; close(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(session.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { const before = document.activeElement as HTMLElement | null; dialog.current?.showModal(); return () => { dialog.current?.close(); if (before?.isConnected) before.focus(); } }, []);
  async function submit() {
    if (busy || !name.trim()) return;
    setBusy(true); setError('');
    try {
      await runtime.command<CommandReceipt<Session>>('sessions.rename', { id: session.id, name: name.trim() }, crypto.randomUUID(), { version: 1 });
      close();
    } catch (failure) { setError(failure instanceof Error ? failure.message : '重命名结果未确认，可重试'); } finally { setBusy(false); }
  }
  const trimmed = name.trim();
  // Confirming the title that is already shown is how an automatic title is kept: it is allowed.
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby="session-rename-title" onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
    <form onSubmit={event => { event.preventDefault(); void submit(); }} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }}>
      <h2 id="session-rename-title">重命名会话</h2>
      <input className={styles.input} aria-label="会话名称" data-modal-autofocus maxLength={120} value={name} disabled={busy}
        autoFocus onFocus={event => event.target.select()} onChange={event => { setName(event.target.value); setError(''); }} />
      {error && <p role="alert" className={styles.error}>{error}</p>}
      <footer><button type="button" disabled={busy} onClick={close}>取消</button><button type="submit" className={styles.primary} disabled={busy || !trimmed}>{busy ? '正在保存…' : '重命名'}</button></footer>
    </form>
  </dialog>;
}
