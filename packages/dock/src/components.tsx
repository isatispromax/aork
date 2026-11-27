/** Docking components: they render a layout snapshot and report each settled gesture to a
 * controller. Everything host-specific — what a tab shows, which words it reads, what may be
 * split, added or closed — arrives through props, so the kit holds no product knowledge.
 * The tab menu and the strip's scroll fades follow deepseek-harness ui-dockkit's TabPanel and
 * TabMenu (MIT). */
import { Fragment, createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties, Dispatch, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode, RefObject, SetStateAction } from 'react';
import { dockedPanes, floatPanes, topRightPaneId } from './engine.js';
import { reduceHistory } from './engine.js';
import type {
  DockController, DockOp, DockSettle, FloatRect, HistoryAction, HistoryRecord, LayoutState, NodeId, PaneId, PaneNode, SplitNode, TabId, TabRecord,
} from './engine.js';
import styles from './dock.module.css';

const cx = (...names: (string | false | undefined)[]): string => names.filter(Boolean).join(' ');
const isOps = (ops: readonly DockOp[] | DockOp): ops is readonly DockOp[] => Array.isArray(ops);

/** What the embedder knows about a panel type; a tab is drawn by looking its `kind` up here. */
export interface DockTabDescriptor {
  kind: string;
  /** The chip's title, or a function of the tab's record, so instances of one kind can be told apart. */
  title: string | ((record: TabRecord) => string);
  icon?: ReactNode;
}
const titleOf = (descriptor: DockTabDescriptor, record: TabRecord): string => (typeof descriptor.title === 'function' ? descriptor.title(record) : descriptor.title);

export interface DockLabels {
  tabList: string;
  addTab: string;
  split: string;
  /** Why a split is refused: the pane budget is spent, or the pane is too narrow to halve. */
  splitBlockedBudget: string;
  splitBlockedNarrow: string;
  divider: string;
  closeTab: string;
  /** The chip's context menu: closing the other tabs of its pane, or those to its right. */
  tabMenu: string;
  closeOthers: string;
  closeRight: string;
  moveFloat: string;
  dockFloat: string;
  closeFloat: string;
  dropLeft: string;
  dropRight: string;
  dropMove: string;
}
export const defaultDockLabels: DockLabels = {
  tabList: '标签页',
  addTab: '新建标签页',
  split: '分屏',
  splitBlockedBudget: '已达两格上限',
  splitBlockedNarrow: '栏宽不足，拖宽后再分屏',
  divider: '调整分屏比例',
  closeTab: '关闭',
  tabMenu: '标签页操作',
  closeOthers: '关闭其他',
  closeRight: '关闭右侧',
  moveFloat: '拖动浮动面板',
  dockFloat: '收回到停靠栏',
  closeFloat: '关闭',
  dropLeft: '左侧分屏',
  dropRight: '右侧分屏',
  dropMove: '移到这里',
};

export type SplitBlock = 'budget' | 'narrow';

export interface DockSurfaceProps {
  dock: DockController;
  tabs: readonly DockTabDescriptor[];
  renderBody(descriptor: DockTabDescriptor, record: TabRecord, options: { floating: boolean }): ReactNode;
  /** Surface-wide controls, drawn at the far end of the top-right pane's strip so the surface
   * needs no header of its own. The kit places them; what they do is the embedder's. */
  chrome?: ReactNode;
  /** The pane budget for side-by-side splits. Width is the kit's own concern. */
  canSplit?: boolean;
  /** Whether a pane's strip draws the add control; omitted draws one in every pane. */
  canAddTab?: (paneId: PaneId) => boolean;
  /** Whether a tab may close through its control or a middle click; omitted keeps every tab closable. */
  canCloseTab?: (tabId: TabId) => boolean;
  onAddTab?: (paneId: PaneId) => void;
  /** How a split fills its new pane, beside `paneId` on that side: with a new tab, or with
   * `tabId` when a tab was dropped on that edge. Without it no split control is drawn and no
   * edge is offered. */
  onSplit?: (paneId: PaneId, side: 'left' | 'right', tabId?: TabId) => void;
  empty?: ReactNode;
  labels?: Partial<DockLabels>;
}

/** A controller bound to React state. The settle rule runs on adoption and after every step. */
export function useDockController(initial: LayoutState, options?: { settle?: DockSettle }): DockController {
  const settle = options?.settle;
  const [record, dispatch] = useReducer(
    (current: HistoryRecord, action: HistoryAction): HistoryRecord => reduceHistory(current, action, settle),
    initial,
    (state: LayoutState): HistoryRecord => reduceHistory({ state, past: [], future: [], gestureStart: undefined }, { t: 'reset', state }, settle),
  );
  const latest = useRef(record);
  latest.current = record;
  return useRef<DockController>({
    get state() { return latest.current.state; },
    apply(ops) { dispatch({ t: 'apply', ops: isOps(ops) ? ops : [ops] }); },
    beginGesture() { dispatch({ t: 'begin' }); },
    endGesture() { dispatch({ t: 'end' }); },
    undo() { dispatch({ t: 'undo' }); },
    redo() { dispatch({ t: 'redo' }); },
    canUndo() { return latest.current.past.length > 0; },
    canRedo() { return latest.current.future.length > 0; },
    reset(state) { dispatch({ t: 'reset', state }); },
  }).current;
}

/* Geometry **************************************************************************************/

/** A pointer must travel this far before a press becomes a drag. */
const DRAG_THRESHOLD = 5;
/** Smallest share a divider may leave a pane. */
export const MIN_PANE_FRACTION = 0.2;
/** Each half of a split must hold the strip's fixed controls and one smallest chip. */
const MIN_HALF_CONTENT = 100;
export const FLOAT_MIN = { width: 280, height: 200 };
const FLOAT_DEFAULT: FloatRect = { x: 80, y: 80, width: 420, height: 320 };
const VIEWPORT_MARGIN = 8;

type DropTarget =
  | { kind: 'strip'; paneId: PaneId; index: number }
  | { kind: 'zone'; paneId: PaneId; zone: 'left' | 'right' | 'center' };
interface Hit { target: DropTarget | undefined; outside: boolean }
/** A gesture in flight: a tab lifted from a docked strip, or a float window moved by its
 * header. Both carry where the pointer is and what a release there would do. */
type Drag =
  | { kind: 'tab'; tabId: TabId; fromPaneId: PaneId; x: number; y: number; target: DropTarget | undefined; outside: boolean }
  | { kind: 'float'; paneId: PaneId; tabId: TabId; x: number; y: number; target: DropTarget | undefined; outside: boolean };
interface Room { width: number; fixed: number }
const NO_ROOMS: ReadonlyMap<PaneId, Room> = new Map();

const contains = (rect: DOMRect, x: number, y: number): boolean => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

function insertionIndex(rects: DOMRect[], x: number): number {
  let index = 0;
  for (const rect of rects) if (rect.left + rect.width / 2 < x) index++;
  return index;
}

/** Where a pointer sits relative to the docked panes. A strip slot that would leave the dragged
 * tab where it is offers nothing; an edge is offered only where a split may follow. */
function hitTest(
  surface: HTMLElement | null,
  panes: ReadonlyMap<PaneId, HTMLElement>,
  x: number,
  y: number,
  tabId: TabId | undefined,
  maySplit: (paneId: PaneId) => boolean,
): Hit {
  const bounds = surface?.getBoundingClientRect();
  const outside = !bounds || !contains(bounds, x, y);
  for (const [paneId, pane] of panes) {
    const rect = pane.getBoundingClientRect();
    if (!contains(rect, x, y)) continue;
    const strip = pane.querySelector<HTMLElement>('[data-dock-strip]');
    const stripBounds = strip?.getBoundingClientRect();
    if (strip && stripBounds && contains(stripBounds, x, y)) {
      const chips = [...strip.querySelectorAll<HTMLElement>('[data-dock-chip]')];
      const index = insertionIndex(chips.map(chip => chip.getBoundingClientRect()), x);
      const source = chips.findIndex(chip => chip.dataset.dockChip === tabId);
      if (source >= 0 && (index === source || index === source + 1)) return { target: undefined, outside };
      return { target: { kind: 'strip', paneId, index }, outside };
    }
    const edge = x < rect.left + rect.width / 2 ? 'left' : 'right';
    return { target: { kind: 'zone', paneId, zone: maySplit(paneId) ? edge : 'center' }, outside };
  }
  return { target: undefined, outside };
}

/** Keeps a float inside the viewport and never smaller than its floor. */
export function clampFloatRect(rect: FloatRect): FloatRect {
  const width = Math.max(FLOAT_MIN.width, Math.min(rect.width, window.innerWidth - VIEWPORT_MARGIN * 2));
  const height = Math.max(FLOAT_MIN.height, Math.min(rect.height, window.innerHeight - VIEWPORT_MARGIN * 2));
  const farthest = (size: number, extent: number): number => Math.max(VIEWPORT_MARGIN, extent - size - VIEWPORT_MARGIN);
  return {
    width,
    height,
    x: Math.round(Math.min(Math.max(VIEWPORT_MARGIN, rect.x), farthest(width, window.innerWidth))),
    y: Math.round(Math.min(Math.max(VIEWPORT_MARGIN, rect.y), farthest(height, window.innerHeight))),
  };
}
const floatRectAt = (x: number, y: number): FloatRect => clampFloatRect({ x: x - 80, y: y - 20, width: FLOAT_DEFAULT.width, height: FLOAT_DEFAULT.height });

/** Moves the boundary between two neighbours by `delta`, leaving the other children alone. */
function withPair(sizes: readonly number[], index: number, delta: number): number[] {
  const next = [...sizes];
  const before = next[index - 1]!;
  const room = before + next[index]!;
  const minimum = Math.min(MIN_PANE_FRACTION, room / 2);
  next[index - 1] = Math.min(room - minimum, Math.max(minimum, before + delta));
  next[index] = room - next[index - 1]!;
  return next;
}

function sameRooms(left: ReadonlyMap<PaneId, Room>, right: ReadonlyMap<PaneId, Room>): boolean {
  if (left.size !== right.size) return false;
  for (const [id, room] of left) {
    const other = right.get(id);
    if (!other || other.width !== room.width || other.fixed !== room.fixed) return false;
  }
  return true;
}

/** The chip a navigation key moves focus to, in the tabs pattern with manual activation. */
function chipFocusTarget(key: string, tabs: readonly TabId[], tabId: TabId): TabId | undefined {
  const index = tabs.indexOf(tabId);
  switch (key) {
    case 'ArrowLeft': return tabs[(index - 1 + tabs.length) % tabs.length];
    case 'ArrowRight': return tabs[(index + 1) % tabs.length];
    case 'Home': return tabs[0];
    case 'End': return tabs.at(-1);
    default: return undefined;
  }
}

/* Strip scroll ************************************************************************************/

/** Width of the chip box's fade at a hidden side; mirrors the stylesheet's 24px. */
const STRIP_FADE = 24;

/** Which sides of the chip box hold chips scrolled out of view, as the `data-dock-strip-scroll`
 * value the stylesheet fades: `undefined` while every chip is in view. A side counts as hidden
 * past one whole pixel, so sub-pixel scroll positions do not flicker the fade. */
function hiddenSides(box: HTMLElement): 'start' | 'end' | 'start end' | undefined {
  const start = box.scrollLeft > 1;
  const end = box.scrollLeft + box.clientWidth < box.scrollWidth - 1;
  if (start && end) return 'start end';
  if (start) return 'start';
  if (end) return 'end';
  return undefined;
}

/** Keeps a chip box readable once its chips overflow it: a side hiding chips fades over its last
 * 24px, the active chip is scrolled clear of that band whenever it or the row changes, and a
 * vertical wheel scrolls the box sideways. The box's scroll position renders nothing, so it is
 * written to the DOM directly rather than through state. */
function useStripScroll(box: RefObject<HTMLDivElement | null>, tabs: readonly TabId[], activeId: TabId | undefined): void {
  useLayoutEffect(() => {
    const box_ = box.current;
    if (!box_) return undefined;
    const fade = (): void => {
      const sides = hiddenSides(box_);
      if (sides === undefined) delete box_.dataset.dockStripScroll;
      else box_.dataset.dockStripScroll = sides;
    };
    // A wheel with no horizontal component of its own scrolls the strip; a trackpad swipe already does.
    const wheel = (event: WheelEvent): void => {
      if (box_.scrollWidth <= box_.clientWidth || event.deltaX !== 0 || event.deltaY === 0) return;
      event.preventDefault();
      box_.scrollLeft += event.deltaY;
    };
    fade();
    box_.addEventListener('scroll', fade, { passive: true });
    box_.addEventListener('wheel', wheel, { passive: false });
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(fade);
    observer?.observe(box_);
    return () => {
      box_.removeEventListener('scroll', fade);
      box_.removeEventListener('wheel', wheel);
      observer?.disconnect();
    };
  }, [box, tabs]);
  useLayoutEffect(() => {
    const element = box.current;
    const chip = activeId === undefined ? undefined : element?.querySelector<HTMLElement>(`[data-dock-chip="${CSS.escape(activeId)}"]`);
    if (!element || !chip) return;
    const bounds = element.getBoundingClientRect();
    const rect = chip.getBoundingClientRect();
    let delta = 0;
    if (rect.left < bounds.left) delta = rect.left - bounds.left - STRIP_FADE;
    else if (rect.right > bounds.right) delta = rect.right - bounds.right + STRIP_FADE;
    if (delta !== 0) element.scrollLeft += delta;
  }, [box, tabs, activeId]);
}

/* Glyphs *****************************************************************************************/

/** The kit's glyphs share one stroke, so embedder chrome drawn with them reads as siblings. */
export function DockGlyph({ children }: { children: ReactNode }): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}
export function PlusGlyph(): ReactNode { return <DockGlyph><path d="M8 3.5v9M3.5 8h9" /></DockGlyph>; }
export function CloseGlyph(): ReactNode { return <DockGlyph><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></DockGlyph>; }
export function SplitGlyph(): ReactNode { return <DockGlyph><rect x="2" y="2.5" width="12" height="11" rx="2" /><path d="M8 2.5v11" /></DockGlyph>; }
export function DockBackGlyph(): ReactNode {
  return <DockGlyph><path d="M8 2v6M5.5 5.5L8 8l2.5-2.5" /><rect x="2.5" y="9.5" width="11" height="4.5" rx="1.5" /></DockGlyph>;
}
function LeftHalfGlyph(): ReactNode { return <DockGlyph><rect x="2" y="2.5" width="12" height="11" rx="2" /><path d="M2.5 3h5v10h-5z" fill="currentColor" stroke="none" /></DockGlyph>; }
function RightHalfGlyph(): ReactNode { return <DockGlyph><rect x="2" y="2.5" width="12" height="11" rx="2" /><path d="M8.5 3h5v10h-5z" fill="currentColor" stroke="none" /></DockGlyph>; }
function MoveHereGlyph(): ReactNode { return <DockGlyph><path d="M8 2.5v8M4.5 7L8 10.5 11.5 7" /><path d="M3 13.5h10" /></DockGlyph>; }

/** A strip control for the embedder's chrome, so its buttons match the kit's own. */
export function DockIconButton({ label, pressed, disabled, onClick, children }: {
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick(): void;
  children: ReactNode;
}): ReactNode {
  return (
    <button type="button" className={styles.stripButton} aria-label={label} title={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

/* Context ****************************************************************************************/

interface DockContextValue {
  dock: DockController;
  descriptors: ReadonlyMap<string, DockTabDescriptor>;
  labels: DockLabels;
  drag: Drag | undefined;
  setDrag(drag: Drag | undefined): void;
  /** A drag's release lands as a click on whatever is under the pointer; that one is dropped. */
  suppressClickUntil: { current: number };
  surface: RefObject<HTMLDivElement | null>;
  registerPane(paneId: PaneId, element: HTMLElement | null): void;
  hit(x: number, y: number, tabId: TabId | undefined): Hit;
  splitBlock(paneId: PaneId): SplitBlock | undefined;
  canAddTab(paneId: PaneId): boolean;
  canCloseTab(tabId: TabId): boolean;
  closeTab(tabId: TabId): void;
  beginTabDrag(event: ReactPointerEvent<HTMLElement>, tabId: TabId, fromPaneId: PaneId): void;
  focusChip(paneId: PaneId, tabId: TabId): void;
  chrome: ReactNode;
  chromePaneId: PaneId | undefined;
  onAddTab: ((paneId: PaneId) => void) | undefined;
  onSplit: DockSurfaceProps['onSplit'];
  renderBody: DockSurfaceProps['renderBody'];
}
const DockContext = createContext<DockContextValue | undefined>(undefined);
function useDockContext(): DockContextValue {
  const value = useContext(DockContext);
  if (!value) throw new Error('dock: missing DockSurface context');
  return value;
}

/* Surface ****************************************************************************************/

/** Renders the docked panes, the floating windows and the drag ghost. */
export function DockSurface(props: DockSurfaceProps) {
  const { dock } = props;
  const state = dock.state;
  const labels = { ...defaultDockLabels, ...props.labels };
  const descriptors = useMemo(() => new Map(props.tabs.map(tab => [tab.kind, tab])), [props.tabs]);
  const paneElements = useRef(new Map<PaneId, HTMLElement>());
  const surface = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag>();
  const [rooms, setRooms] = useState<ReadonlyMap<PaneId, Room>>(NO_ROOMS);
  const suppressClickUntil = useRef(0);
  // The window-level gesture handlers read the drag through a ref: their effect is attached
  // once per gesture, so a later render must not resubscribe it mid-drag.
  const dragRef = useRef<Drag | undefined>(undefined);
  dragRef.current = drag;
  const paneKey = dockedPanes(state).map(pane => pane.id).join(' ');
  const splittable = props.canSplit === true && props.onSplit !== undefined;

  const registerPane = useCallback((paneId: PaneId, element: HTMLElement | null) => {
    if (element) paneElements.current.set(paneId, element);
    else paneElements.current.delete(paneId);
  }, []);

  // Room readings: a pane's own width against its strip's fixed controls decides whether it
  // may halve. Reading layout never changes what renders, only whether a split is offered.
  useLayoutEffect(() => {
    const root = surface.current;
    if (!root || typeof ResizeObserver === 'undefined') return;
    const read = () => {
      const next = new Map<PaneId, Room>();
      for (const [id, pane] of paneElements.current) {
        const strip = pane.querySelector<HTMLElement>('[data-dock-strip]');
        const chips = strip?.querySelector<HTMLElement>('[data-dock-chips]');
        const fill = strip?.querySelector<HTMLElement>('[data-dock-fill]');
        next.set(id, { width: pane.clientWidth, fixed: strip ? strip.clientWidth - (chips?.clientWidth ?? 0) - (fill?.clientWidth ?? 0) : 0 });
      }
      setRooms(current => sameRooms(current, next) ? current : next);
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(root);
    for (const pane of paneElements.current.values()) {
      observer.observe(pane);
      for (const box of pane.querySelectorAll('[data-dock-strip], [data-dock-chips], [data-dock-fill]')) observer.observe(box);
    }
    return () => observer.disconnect();
  }, [paneKey]);

  const splitBlock = useCallback((paneId: PaneId): SplitBlock | undefined => {
    if (!splittable) return 'budget';
    const room = rooms.get(paneId);
    // An unmeasured pane fits until a reading says otherwise.
    return room && room.width / 2 < room.fixed + MIN_HALF_CONTENT ? 'narrow' : undefined;
  }, [splittable, rooms]);

  const hit = useCallback((x: number, y: number, tabId: TabId | undefined): Hit => {
    return hitTest(surface.current, paneElements.current, x, y, tabId, paneId => splitBlock(paneId) === undefined);
  }, [splitBlock]);

  /** Where a released drag lands, as one controller call. */
  const settle = useCallback((current: Drag, x: number, y: number) => {
    const landing = hit(x, y, current.tabId);
    const target = landing.target;
    if (current.kind === 'float') {
      if (target) dock.apply({ type: 'dock-pane', paneId: current.paneId, toPaneId: target.paneId });
      return;
    }
    const tabId = current.tabId;
    if (target?.kind === 'strip') {
      dock.apply({ type: 'move-tab', tabId, ...(target.paneId === current.fromPaneId ? {} : { toPaneId: target.paneId }), index: target.index });
    } else if (target?.kind === 'zone' && target.zone !== 'center') {
      props.onSplit?.(target.paneId, target.zone, tabId);
    } else if (target?.kind === 'zone') {
      if (target.paneId !== current.fromPaneId) dock.apply({ type: 'move-tab', tabId, toPaneId: target.paneId });
    } else if (landing.outside) {
      dock.apply({ type: 'move-tab', tabId, floatRect: floatRectAt(x, y) });
    }
  }, [dock, hit, props.onSplit]);

  // From the first dragged pixel a tab's gesture lives on the window, so the pointer may leave
  // the chip — and its capture — without the drag being abandoned.
  const dragging = drag?.kind === 'tab';
  const settleRef = useRef(settle);
  settleRef.current = settle;
  useEffect(() => {
    if (!dragging) return;
    const probe = (event: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      const found = hit(event.clientX, event.clientY, current.tabId);
      setDrag({ ...current, x: event.clientX, y: event.clientY, target: found.target, outside: found.outside });
    };
    const finish = (event: PointerEvent) => {
      const current = dragRef.current;
      dragRef.current = undefined;
      suppressClickUntil.current = performance.now() + 400;
      setDrag(undefined);
      if (current) settleRef.current(current, event.clientX, event.clientY);
    };
    const drop = () => {
      dragRef.current = undefined;
      setDrag(undefined);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') drop(); };
    window.addEventListener('pointermove', probe);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', drop);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointermove', probe);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', drop);
      window.removeEventListener('keydown', escape);
    };
  }, [dragging, hit]);

  const beginTabDrag = useCallback((event: ReactPointerEvent<HTMLElement>, tabId: TabId, fromPaneId: PaneId) => {
    if (!event.isPrimary || event.button !== 0) return;
    const element = event.currentTarget;
    const pointerId = event.pointerId;
    const start = { x: event.clientX, y: event.clientY };
    const release = () => {
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', up);
      if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
    };
    const move = (moved: PointerEvent) => {
      if (Math.hypot(moved.clientX - start.x, moved.clientY - start.y) < DRAG_THRESHOLD) return;
      // A drag has begun: hand the gesture to the window listeners instead of this capture.
      release();
      const found = hit(moved.clientX, moved.clientY, tabId);
      setDrag({ kind: 'tab', tabId, fromPaneId, x: moved.clientX, y: moved.clientY, target: found.target, outside: found.outside });
    };
    const up = () => release();
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', up);
    element.setPointerCapture(pointerId);
  }, [hit]);

  const closeTab = useCallback((tabId: TabId) => {
    dock.apply({ type: 'close-tab', tabId });
    // Closing from the chip's own control drops focus with it: hand it to the tab that takes over.
    requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      surface.current?.querySelector<HTMLElement>('[data-dock-chip][aria-selected="true"]')?.focus({ preventScroll: true });
    });
  }, [dock]);

  const focusChip = useCallback((paneId: PaneId, tabId: TabId) => {
    paneElements.current.get(paneId)?.querySelector<HTMLElement>(`[data-dock-chip="${CSS.escape(tabId)}"]`)?.focus({ preventScroll: true });
  }, []);

  const context: DockContextValue = {
    dock,
    descriptors,
    labels,
    drag,
    setDrag,
    suppressClickUntil,
    surface,
    registerPane,
    hit,
    splitBlock,
    canAddTab: props.canAddTab ?? (() => true),
    canCloseTab: props.canCloseTab ?? (() => true),
    closeTab,
    beginTabDrag,
    focusChip,
    chrome: props.chrome,
    chromePaneId: topRightPaneId(state),
    onAddTab: props.onAddTab,
    onSplit: props.onSplit,
    renderBody: props.renderBody,
  };
  const lifted = drag?.kind === 'tab' ? descriptors.get(state.tabs[drag.tabId]?.kind ?? '') : undefined;
  const liftedRecord = drag?.kind === 'tab' ? state.tabs[drag.tabId] : undefined;
  return (
    <DockContext.Provider value={context}>
      <div ref={surface} className={styles.surface} data-dock-surface data-dock-dragging={drag ? '' : undefined}>
        {state.rootId ? <DockTree rootId={state.rootId} /> : props.empty}
        <FloatLayer />
        {drag?.kind === 'tab' && liftedRecord && lifted && (
          <div className={styles.dragGhost} style={{ left: drag.x + 12, top: drag.y + 12 }}>
            {lifted.icon && <span aria-hidden="true">{lifted.icon}</span>}
            {titleOf(lifted, liftedRecord)}
          </div>
        )}
      </div>
    </DockContext.Provider>
  );
}

/** The docked panes as one flat keyed row — no wrappers around a root-level pane — so a pane
 * keeps its element, and its mounted tab body, when a split opens beside it or closes away. */
function DockTree({ rootId }: { rootId: NodeId }) {
  const { dock } = useDockContext();
  const root = dock.state.nodes[rootId];
  if (!root) return null;
  const items: ReactNode[] = [];
  const children = root.type === 'split' ? root.children : [root.id];
  children.forEach((child, index) => {
    if (root.type === 'split' && index > 0) items.push(<Divider key={`${root.id}:${index}`} split={root} index={index} />);
    const basis = root.type === 'split' ? root.sizes[index] ?? 0 : 1;
    const node = dock.state.nodes[child];
    if (!node) return;
    // Deeper splits recurse behind a wrapper; only the root level needs the stable identity.
    if (node.type === 'pane') items.push(<DockPane key={node.id} pane={node} basis={basis} />);
    else items.push(<div key={node.id} className={styles.splitChild} style={{ flexBasis: `${basis * 100}%` }}><SplitBranch split={node} /></div>);
  });
  return <div className={cx(styles.tree, root.type === 'split' && root.direction === 'column' && styles.splitColumn)}>{items}</div>;
}
function SplitBranch({ split }: { split: SplitNode }) {
  const { dock } = useDockContext();
  const items: ReactNode[] = [];
  split.children.forEach((child, index) => {
    if (index > 0) items.push(<Divider key={`${split.id}:${index}`} split={split} index={index} />);
    const node = dock.state.nodes[child];
    if (!node) return;
    const basis = split.sizes[index] ?? 0;
    if (node.type === 'pane') items.push(<DockPane key={node.id} pane={node} basis={basis} />);
    else items.push(<div key={node.id} className={styles.splitChild} style={{ flexBasis: `${basis * 100}%` }}><SplitBranch split={node} /></div>);
  });
  return <div className={cx(styles.splitRow, split.direction === 'column' && styles.splitColumn)} data-dock-split={split.id}>{items}</div>;
}

function Divider({ split, index }: { split: SplitNode; index: number }) {
  const { dock, labels } = useDockContext();
  const element = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ origin: number; extent: number; sizes: number[] } | null>(null);
  const horizontal = split.direction === 'row';
  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    const extent = horizontal ? element.current?.parentElement?.clientWidth : element.current?.parentElement?.clientHeight;
    gesture.current = { origin: horizontal ? event.clientX : event.clientY, extent: Math.max(1, extent ?? 1), sizes: [...split.sizes] };
    event.currentTarget.setPointerCapture(event.pointerId);
    dock.beginGesture();
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current || !element.current?.hasPointerCapture(event.pointerId)) return;
    const travelled = (horizontal ? event.clientX : event.clientY) - current.origin;
    dock.apply({ type: 'resize-split', splitId: split.id, sizes: withPair(current.sizes, index, travelled / current.extent) });
  };
  const stop = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (element.current?.hasPointerCapture(event.pointerId)) element.current.releasePointerCapture(event.pointerId);
    gesture.current = null;
    dock.endGesture();
  };
  const nudge = (delta: number) => dock.apply({ type: 'resize-split', splitId: split.id, sizes: withPair(split.sizes, index, delta) });
  return (
    <div
      ref={element}
      className={cx(styles.divider, horizontal ? styles.dividerVertical : styles.dividerHorizontal)}
      role="separator"
      aria-orientation={horizontal ? 'vertical' : 'horizontal'}
      aria-label={labels.divider}
      aria-valuemin={Math.round(MIN_PANE_FRACTION * 100)}
      aria-valuemax={Math.round((1 - MIN_PANE_FRACTION) * 100)}
      aria-valuenow={Math.round((split.sizes[index - 1] ?? 0) * 100)}
      tabIndex={0}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onKeyDown={event => {
        // Along a row, Right grows the pane on the left; along a column, Down grows the pane above.
        const forward = horizontal ? 'ArrowRight' : 'ArrowDown';
        const backward = horizontal ? 'ArrowLeft' : 'ArrowUp';
        const delta = event.key === forward ? 0.02 : event.key === backward ? -0.02 : event.key === 'Home' ? -1 : event.key === 'End' ? 1 : undefined;
        if (delta === undefined) return;
        event.preventDefault();
        nudge(delta);
      }}
    />
  );
}

/** One pane: its tab strip (drag source, drop target, controls) and the active tab's body. */
function DockPane({ pane, basis }: { pane: PaneNode; basis: number }) {
  const context = useDockContext();
  const { dock, descriptors, labels, drag, chrome, chromePaneId, onAddTab, onSplit } = context;
  const element = useRef<HTMLElement>(null);
  const chipsBox = useRef<HTMLDivElement>(null);
  // The open context menu and the chip that opened it; the menu positions itself against that chip.
  const [menu, setMenu] = useState<OpenMenu>();
  useLayoutEffect(() => {
    context.registerPane(pane.id, element.current);
    return () => context.registerPane(pane.id, null);
  }, [context.registerPane, pane.id]);
  const state = dock.state;
  const activeId = pane.active ?? pane.tabs[0];
  useStripScroll(chipsBox, pane.tabs, activeId);
  const active = activeId ? state.tabs[activeId] : undefined;
  const activeDescriptor = active ? descriptors.get(active.kind) : undefined;
  const block = context.splitBlock(pane.id);
  const stripTarget = drag?.target?.kind === 'strip' && drag.target.paneId === pane.id ? drag.target.index : undefined;
  const zone = drag?.target?.kind === 'zone' && drag.target.paneId === pane.id ? drag.target.zone : undefined;
  // Releasing over the pane a lifted tab came from moves nothing, so the pane says nothing either.
  const hovered = zone !== undefined && !(zone === 'center' && drag?.kind === 'tab' && drag.fromPaneId === pane.id);
  const reason = block === 'budget' ? labels.splitBlockedBudget : block === 'narrow' ? labels.splitBlockedNarrow : labels.split;
  return (
    <section ref={element} className={styles.pane} data-dock-pane={pane.id} tabIndex={-1} style={{ flexBasis: `${basis * 100}%` }}>
      <div className={styles.tabStrip} role="tablist" aria-label={labels.tabList} data-dock-strip>
        <div ref={chipsBox} className={styles.stripChips} data-dock-chips>
          {pane.tabs.map((tabId, index) => (
            <Fragment key={tabId}>
              {(index > 0 || stripTarget === index) && (
                <span className={cx(styles.slot, stripTarget === index && styles.slotCaret)} data-dock-caret={stripTarget === index ? index : undefined} />
              )}
              <TabChip pane={pane} tabId={tabId} selected={tabId === activeId} onMenu={setMenu} />
            </Fragment>
          ))}
          {stripTarget === pane.tabs.length && <span className={cx(styles.slot, styles.slotCaret)} data-dock-caret={stripTarget} />}
        </div>
        {onAddTab && context.canAddTab(pane.id) && (
          <button type="button" className={styles.stripButton} aria-label={labels.addTab} title={labels.addTab} data-dock-add
            onClick={event => { event.stopPropagation(); onAddTab(pane.id); }}>
            <PlusGlyph />
          </button>
        )}
        <div className={styles.stripFill} data-dock-fill />
        {onSplit && (
          <span className={styles.splitControl} data-dock-split-control title={reason}
            tabIndex={block ? 0 : undefined} aria-label={block ? reason : undefined}>
            <button type="button" className={styles.stripButton} aria-label={labels.split} disabled={block !== undefined}
              data-dock-split data-dock-split-blocked={block}
              onClick={event => { event.stopPropagation(); if (context.splitBlock(pane.id) === undefined) onSplit(pane.id, 'right'); }}>
              <SplitGlyph />
            </button>
          </span>
        )}
        {pane.id === chromePaneId && chrome !== undefined && (
          <div className={styles.stripChrome} data-dock-chrome onClick={event => event.stopPropagation()}>{chrome}</div>
        )}
      </div>
      <div className={styles.paneBody} data-dock-pane-body>
        {/* Keyed by tab: one mounted body is one tab, so a body never has to follow a change of identity. */}
        {active && activeDescriptor ? <Fragment key={active.id}>{context.renderBody(activeDescriptor, active, { floating: false })}</Fragment> : null}
        {hovered && zone !== undefined && (
          <>
            <div className={styles.dropScrim} />
            <div className={styles.dropHint} data-zone={zone} data-active>
              <div className={styles.dropHintCard}>
                {zone === 'left' ? <LeftHalfGlyph /> : zone === 'right' ? <RightHalfGlyph /> : <MoveHereGlyph />}
                {zone === 'left' ? labels.dropLeft : zone === 'right' ? labels.dropRight : labels.dropMove}
              </div>
            </div>
          </>
        )}
      </div>
      {menu && pane.tabs.includes(menu.tabId) && <TabMenu pane={pane} tabId={menu.tabId} anchor={menu.anchor} dismiss={() => setMenu(undefined)} />}
    </section>
  );
}

/** A chip's context menu while it is open, and the chip it hangs from. */
interface OpenMenu { tabId: TabId; anchor: HTMLElement }

/** A tab's chip: its title, and while active, hovered or focused its close control over the
 * title's end. A middle click anywhere on the chip closes without selecting; a secondary press
 * opens the tab's context menu. */
function TabChip({ pane, tabId, selected, onMenu }: { pane: PaneNode; tabId: TabId; selected: boolean; onMenu: Dispatch<SetStateAction<OpenMenu | undefined>> }) {
  const context = useDockContext();
  const { dock, descriptors, labels } = context;
  const record = dock.state.tabs[tabId];
  const descriptor = record ? descriptors.get(record.kind) : undefined;
  const dragging = context.drag?.kind === 'tab' && context.drag.tabId === tabId;
  if (!record || !descriptor) return null;
  const title = titleOf(descriptor, record);
  const closable = context.canCloseTab(tabId);
  // A pane's lone unclosable chip is a label, not a choice.
  const quiet = !closable && pane.tabs.length === 1;
  const activate = () => { if (!selected) dock.apply({ type: 'activate-tab', paneId: pane.id, tabId }); };
  return (
    <div
      role="tab"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      data-dock-chip={tabId}
      data-dock-tab={record.kind}
      className={cx(styles.tab, closable && styles.tabClosable, selected && styles.tabActive, quiet && styles.tabQuiet, dragging && styles.tabDragging)}
      onPointerDown={event => context.beginTabDrag(event, tabId, pane.id)}
      onMouseDown={event => { if (event.button === 1) event.preventDefault(); }}
      onAuxClick={event => {
        if (event.button !== 1 || !closable || event.buttons !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        context.closeTab(tabId);
      }}
      onClick={event => {
        // The release that ended a drag lands here too; it is not a click.
        if (performance.now() < context.suppressClickUntil.current) return;
        event.stopPropagation();
        activate();
      }}
      onContextMenu={event => {
        event.preventDefault();
        event.stopPropagation();
        // A secondary press is a gesture on this tab: it takes focus, so Escape has somewhere to return.
        event.currentTarget.focus({ preventScroll: true });
        const anchor = event.currentTarget;
        onMenu(current => current?.tabId === tabId ? undefined : { tabId, anchor });
      }}
      onKeyDown={event => {
        if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return;
        const next = chipFocusTarget(event.key, pane.tabs, tabId);
        if (next !== undefined) { event.preventDefault(); context.focusChip(pane.id, next); return; }
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); }
        // The context-menu key opens the same menu the secondary press does.
        if (event.key === 'ContextMenu') onMenu(current => current?.tabId === tabId ? undefined : { tabId, anchor: event.currentTarget });
      }}
    >
      <span className={styles.tabTitle}>
        {descriptor.icon && <span className={styles.tabIcon} aria-hidden="true">{descriptor.icon}</span>}
        {title}
      </span>
      {closable && (
        <button type="button" className={styles.tabClose} aria-label={`${labels.closeTab}：${title}`} title={labels.closeTab} data-dock-tab-close
          onPointerDown={event => event.stopPropagation()}
          onClick={event => { event.stopPropagation(); context.closeTab(tabId); }}>
          <CloseGlyph />
        </button>
      )}
    </div>
  );
}

/* Tab menu ****************************************************************************************/

/** Gap between the opening chip and the menu. */
const MENU_GAP = 4;

/** Where the menu sits: under its chip, hung from the chip's left edge, or from its right edge
 * when the menu would run off the viewport — as it would for the last chip against the window. */
function placeMenu(anchor: HTMLElement, menu: HTMLElement): CSSProperties {
  const rect = anchor.getBoundingClientRect();
  const left = rect.left + menu.offsetWidth + MENU_GAP > window.innerWidth ? Math.max(MENU_GAP, rect.right - menu.offsetWidth) : rect.left;
  return { top: rect.bottom + MENU_GAP, left };
}

/** The per-tab context menu: the close gesture, then the two batch closes over its own pane —
 * the other tabs, and those to the right when there are any to close. It renders in a portal
 * inside the surface, because the strip clips its overflow on purpose and a menu drawn within it
 * would be clipped too. It dismisses itself on an outside press or an unmodified Escape, returning
 * focus to its chip. A menu that would hold no item renders no popup. */
function TabMenu({ pane, tabId, anchor, dismiss }: { pane: PaneNode; tabId: TabId; anchor: HTMLElement; dismiss(): void }) {
  const { labels, canCloseTab, closeTab, surface } = useDockContext();
  const self = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>();
  const closable = (id: TabId): boolean => canCloseTab(id);
  const close = closable(tabId);
  const others = pane.tabs.filter(id => id !== tabId && closable(id));
  const right = pane.tabs.slice(pane.tabs.indexOf(tabId) + 1).filter(closable);
  const latest = useRef(dismiss);
  latest.current = dismiss;
  useLayoutEffect(() => {
    // Unplaced for one layout pass: measured, then positioned.
    if (self.current) setPosition(placeMenu(anchor, self.current));
  }, [anchor]);
  useEffect(() => {
    const menu = self.current;
    if (!menu) return undefined;
    menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    // Capture: an Escape here must not also close the region behind the menu, and a press on a
    // chip must dismiss the menu before that chip's own handlers can start a drag.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        latest.current();
        anchor.focus({ preventScroll: true });
      }
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && menu.contains(event.target)) return;
      latest.current();
    };
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [anchor]);
  if (!close && !others.length) return null;
  /** The menu pattern's keys: the arrows and their ends move between items; a choice closes it. */
  const navigate = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const target = event.key === 'ArrowDown' ? items[(at + 1) % items.length] : event.key === 'ArrowUp' ? items[(at - 1 + items.length) % items.length] : event.key === 'Home' ? items[0] : event.key === 'End' ? items.at(-1) : undefined;
    if (!target) return;
    event.preventDefault();
    target.focus({ preventScroll: true });
  };
  // Portal events still bubble to the chip that opened the menu: a press would start a drag, a
  // click would focus it, and a middle click would close the tab.
  const alone = (event: { stopPropagation(): void }): void => event.stopPropagation();
  return createPortal(
    <div ref={self} role="menu" aria-label={labels.tabMenu} className={styles.tabMenu} data-dock-tab-menu
      style={position ?? { visibility: 'hidden', top: 0, left: 0 }}
      onPointerDown={alone} onClick={alone} onAuxClick={alone} onKeyDown={event => { alone(event); navigate(event); }}>
      {close && <button type="button" role="menuitem" className={styles.tabMenuItem} data-dock-menu-close onClick={() => { dismiss(); closeTab(tabId); }}>{labels.closeTab}</button>}
      {others.length > 0 && <button type="button" role="menuitem" className={styles.tabMenuItem} data-dock-menu-close-others onClick={() => { dismiss(); for (const id of others) closeTab(id); }}>{labels.closeOthers}</button>}
      {right.length > 0 && <button type="button" role="menuitem" className={styles.tabMenuItem} data-dock-menu-close-right onClick={() => { dismiss(); for (const id of right) closeTab(id); }}>{labels.closeRight}</button>}
    </div>,
    surface.current ?? document.body,
  );
}

/* Floats *****************************************************************************************/

function FloatLayer(): ReactNode {
  const { dock } = useDockContext();
  const floats = floatPanes(dock.state);
  if (!floats.length) return null;
  // A stable DOM order keeps a window's element in place while it is raised mid-gesture; the
  // stack is painted by z-index instead.
  const serial = (id: PaneId): number => Number(id.slice(2)) || 0;
  const ordered = [...floats].sort((left, right) => serial(left.id) - serial(right.id));
  return <>{ordered.map(pane => <FloatWindow key={pane.id} pane={pane} depth={dock.state.floats.indexOf(pane.id)} />)}</>;
}

/** One floating pane: a viewport-positioned window whose header is the move grip. */
function FloatWindow({ pane, depth }: { pane: PaneNode; depth: number }) {
  const context = useDockContext();
  const { dock, descriptors, labels } = context;
  const state = dock.state;
  const record = pane.tabs[0] ? state.tabs[pane.tabs[0]] : undefined;
  const descriptor = record ? descriptors.get(record.kind) : undefined;
  if (!record || !descriptor) return null;
  const title = titleOf(descriptor, record);
  // A window is drawn at its stored rectangle projected into the viewport, so a smaller window
  // pushes floats back inside without recording an operation.
  const rect = clampFloatRect(state.rects[pane.id] ?? FLOAT_DEFAULT);
  const beginMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    const element = event.currentTarget;
    const pointerId = event.pointerId;
    const start = { x: event.clientX, y: event.clientY, rect };
    let dragging = false;
    const release = () => {
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', up);
      if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
    };
    const move = (moved: PointerEvent) => {
      dragging ||= Math.hypot(moved.clientX - start.x, moved.clientY - start.y) >= DRAG_THRESHOLD;
      if (!dragging) return;
      const next = clampFloatRect({ ...start.rect, x: start.rect.x + moved.clientX - start.x, y: start.rect.y + moved.clientY - start.y });
      dock.apply({ type: 'move-float', paneId: pane.id, rect: next });
      // Released over a docked pane, the window goes back into the dock.
      context.setDrag({ kind: 'float', paneId: pane.id, tabId: record.id, x: moved.clientX, y: moved.clientY, ...context.hit(moved.clientX, moved.clientY, undefined) });
    };
    const up = (released: PointerEvent) => {
      release();
      dock.endGesture();
      context.setDrag(undefined);
      if (!dragging) return;
      const landing = context.hit(released.clientX, released.clientY, undefined);
      if (landing.target) dock.apply({ type: 'dock-pane', paneId: pane.id, toPaneId: landing.target.paneId });
    };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', up);
    element.setPointerCapture(pointerId);
    dock.beginGesture();
  };
  const beginResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    const element = event.currentTarget;
    const pointerId = event.pointerId;
    const start = { x: event.clientX, y: event.clientY, rect };
    const release = () => {
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', up);
      if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
    };
    const move = (moved: PointerEvent) => {
      // The corner stays inside the viewport.
      const width = Math.min(start.rect.width + moved.clientX - start.x, window.innerWidth - start.rect.x - VIEWPORT_MARGIN);
      const height = Math.min(start.rect.height + moved.clientY - start.y, window.innerHeight - start.rect.y - VIEWPORT_MARGIN);
      dock.apply({ type: 'move-float', paneId: pane.id, rect: { ...start.rect, width: Math.max(FLOAT_MIN.width, width), height: Math.max(FLOAT_MIN.height, height) } });
    };
    const up = () => { release(); dock.endGesture(); };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', up);
    element.setPointerCapture(pointerId);
    dock.beginGesture();
  };
  return (
    <div className={styles.floatWindow} data-dock-float={pane.id} data-dock-float-active={depth === state.floats.length - 1 ? '' : undefined}
      style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height, zIndex: 40 + depth }}
      onPointerDown={() => dock.apply({ type: 'focus-float', paneId: pane.id })}>
      <div className={styles.floatHeader} data-dock-float-header title={labels.moveFloat} onPointerDown={beginMove}>
        <span className={styles.floatTitle}>
          {descriptor.icon && <span aria-hidden="true">{descriptor.icon}</span>}
          {title}
        </span>
        <button type="button" className={styles.stripButton} aria-label={labels.dockFloat} title={labels.dockFloat} data-dock-float-dock
          onPointerDown={event => event.stopPropagation()} onClick={() => dock.apply({ type: 'dock-pane', paneId: pane.id })}>
          <DockBackGlyph />
        </button>
        <button type="button" className={styles.stripButton} aria-label={`${labels.closeFloat}：${title}`} title={labels.closeFloat} data-dock-float-close
          onPointerDown={event => event.stopPropagation()} onClick={() => context.closeTab(record.id)}>
          <CloseGlyph />
        </button>
      </div>
      <div className={styles.paneBody}><Fragment key={record.id}>{context.renderBody(descriptor, record, { floating: true })}</Fragment></div>
      <div className={styles.floatResize} data-dock-float-resize onPointerDown={beginResize} />
    </div>
  );
}
