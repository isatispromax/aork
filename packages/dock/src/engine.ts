/** Docking layout engine: a normalized split tree of tabbed panes with floats.
 * Pure logic, no DOM, no React. State is JSON-serializable so an embedder can persist it.
 *
 * A tab is a record in `state.tabs`, keyed by its id and carrying an opaque `kind`; panes only
 * reference tab ids, so the same kind can be open more than once and moving a tab never touches
 * what it shows. `content` tells two tabs of one kind apart: it is whatever the embedder's kind
 * shows — an address, an instance key — and lets content already open be revealed, not duplicated.
 * Every operation returns the next state and leaves its input alone.
 * History is snapshot-based: one entry per committed change, gestured changes coalesce. */

export type PaneId = `p-${string}`;
export type SplitId = `s-${string}`;
export type TabId = `t-${string}`;
export type NodeId = PaneId | SplitId;

/** One open tab. `kind` is opaque to the kit: the embedder names its panel types and renders by it.
 * `content` is opaque as well: what this instance of the kind shows, absent for a kind that has
 * only one instance. */
export interface TabRecord {
  id: TabId;
  kind: string;
  content?: string;
}
/** Longest `content` a tab record carries, and the longest a persisted layout may hold. */
export const TAB_CONTENT_LIMIT = 1024;

export interface PaneNode {
  type: 'pane';
  id: PaneId;
  host: 'docked' | 'float';
  /** A float pane holds exactly one tab and renders no tab strip. */
  tabs: TabId[];
  active: TabId | undefined;
}
export interface SplitNode {
  type: 'split';
  id: SplitId;
  direction: 'row' | 'column';
  children: NodeId[];
  /** Child weights, one per child, each > 0, normalizing to 1 after every op. */
  sizes: number[];
}
export type DockNode = PaneNode | SplitNode;

export interface FloatRect { x: number; y: number; width: number; height: number }

export interface LayoutState {
  nodes: Record<string, DockNode>;
  /** Every open tab, keyed by id. */
  tabs: Record<string, TabRecord>;
  /** The docked tree; undefined while nothing is docked (floats may remain). */
  rootId: NodeId | undefined;
  /** Floating panes, bottom to top. */
  floats: PaneId[];
  rects: Record<string, FloatRect>;
  /** Minted-id counter, carried in the state so a persisted layout never reissues an id. */
  counter: number;
}

export type DockOp =
  /** Opens a tab of `kind`: in `paneId`, else the first docked pane, else a new root pane.
   * `tabId` lets the embedder name the tab, `content` says what it shows, `index` places it in the strip. */
  | { type: 'open-tab'; kind: string; tabId?: TabId; paneId?: PaneId; index?: number; activate?: boolean; content?: string }
  | { type: 'close-tab'; tabId: TabId }
  | { type: 'activate-tab'; paneId: PaneId; tabId: TabId }
  /** Reorders in place, moves to another docked pane, or — with `floatRect` — floats the tab. */
  | { type: 'move-tab'; tabId: TabId; toPaneId?: PaneId; index?: number; floatRect?: FloatRect }
  /** Divides `paneId` and fills the new pane with `seed`: an existing tab moved there, or a
   * fresh tab of `seed.kind` showing `seed.content`. A source pane the moved tab leaves empty is
   * refilled with `refillKind`, or discarded without it. */
  | {
    type: 'split-pane';
    paneId: PaneId;
    side: 'before' | 'after';
    direction?: 'row' | 'column';
    seed?: { tabId?: TabId; kind?: string; content?: string };
    refillKind?: string;
  }
  | { type: 'close-pane'; paneId: PaneId }
  | { type: 'resize-split'; splitId: SplitId; sizes: number[] }
  | { type: 'float-pane'; paneId: PaneId; rect: FloatRect }
  | { type: 'move-float'; paneId: PaneId; rect: FloatRect }
  | { type: 'focus-float'; paneId: PaneId }
  | { type: 'close-float'; paneId: PaneId }
  /** Returns a float pane to the dock: its tab joins `toPaneId`, else the first docked pane. */
  | { type: 'dock-pane'; paneId: PaneId; toPaneId?: PaneId };

export const emptyLayout = (): LayoutState => ({ nodes: {}, tabs: {}, rootId: undefined, floats: [], rects: {}, counter: 1 });

export function paneNode(id: PaneId, host: 'docked' | 'float'): PaneNode { return { type: 'pane', id, host, tabs: [], active: undefined }; }
export function splitNode(id: SplitId, direction: 'row' | 'column', children: NodeId[], sizes: number[]): SplitNode { return { type: 'split', id, direction, children, sizes }; }

export function clone(state: LayoutState): LayoutState {
  return {
    nodes: structuredClone(state.nodes),
    tabs: structuredClone(state.tabs),
    rootId: state.rootId,
    floats: [...state.floats],
    rects: structuredClone(state.rects),
    counter: state.counter,
  };
}

function freshId<T extends NodeId | TabId>(state: LayoutState, prefix: 'p-' | 's-' | 't-'): T {
  let id = `${prefix}${state.counter++}` as T;
  // A counter repaired after hand-edited storage can still meet a taken id; skip past it.
  while (state.nodes[id] || state.tabs[id]) id = `${prefix}${state.counter++}` as T;
  return id;
}

function normalize(sizes: number[]): number[] {
  const total = sizes.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return sizes.map(() => 1 / sizes.length);
  return sizes.map(value => value / total);
}

function parentOf(state: LayoutState, id: NodeId): { parent: SplitNode; index: number } | undefined {
  for (const node of Object.values(state.nodes)) {
    if (node.type !== 'split') continue;
    const index = node.children.indexOf(id);
    if (index >= 0) return { parent: node, index };
  }
  return undefined;
}

function paneOf(state: LayoutState, paneId: PaneId): PaneNode | undefined {
  const node = state.nodes[paneId];
  return node && node.type === 'pane' ? node : undefined;
}

/** A split with one child collapses into that child; an emptied split disappears. */
function collapse(state: LayoutState, id: NodeId): void {
  const node = state.nodes[id];
  if (!node || node.type !== 'split' || node.children.length > 1) return;
  delete state.nodes[id];
  const parent = parentOf(state, id);
  const only = node.children[0];
  if (!parent) {
    state.rootId = only;
    if (only) collapse(state, only);
    return;
  }
  if (only === undefined) {
    parent.parent.children.splice(parent.index, 1);
    parent.parent.sizes.splice(parent.index, 1);
    parent.parent.sizes = normalize(parent.parent.sizes);
    collapse(state, parent.parent.id);
    return;
  }
  parent.parent.children[parent.index] = only;
  collapse(state, only);
}

/** Removes a pane and whatever tabs it still holds, then collapses its ancestors. */
function forgetPane(state: LayoutState, paneId: PaneId): void {
  const pane = paneOf(state, paneId);
  if (!pane) return;
  for (const tabId of pane.tabs) delete state.tabs[tabId];
  delete state.nodes[paneId];
  delete state.rects[paneId];
  state.floats = state.floats.filter(item => item !== paneId);
  const parent = parentOf(state, paneId);
  if (!parent) {
    if (state.rootId === paneId) state.rootId = undefined;
    return;
  }
  parent.parent.children.splice(parent.index, 1);
  parent.parent.sizes.splice(parent.index, 1);
  parent.parent.sizes = normalize(parent.parent.sizes);
  collapse(state, parent.parent.id);
}

/** A docked pane never outlives its last tab. */
function settlePane(state: LayoutState, paneId: PaneId): void {
  const pane = paneOf(state, paneId);
  if (pane && !pane.tabs.length) forgetPane(state, paneId);
}

function addRecord(state: LayoutState, kind: string, tabId: TabId | undefined, content: string | undefined): TabId {
  const id = tabId ?? freshId<TabId>(state, 't-');
  if (state.tabs[id]) throw new Error(`dock: tab ${id} already exists`);
  state.tabs[id] = content === undefined ? { id, kind } : { id, kind, content };
  return id;
}

function insertTab(pane: PaneNode, tabId: TabId, index: number | undefined, activate: boolean): void {
  const at = Math.max(0, Math.min(index ?? pane.tabs.length, pane.tabs.length));
  pane.tabs.splice(at, 0, tabId);
  if (activate) pane.active = tabId;
}

function removeTab(state: LayoutState, tabId: TabId): { tab: TabRecord; pane: PaneNode; index: number } {
  const found = findTab(state, tabId);
  if (!found) throw new Error(`dock: unknown tab ${tabId}`);
  found.pane.tabs.splice(found.index, 1);
  // The neighbour takes over: the tab before it, else the one after.
  if (found.pane.active === tabId) found.pane.active = found.pane.tabs[Math.max(0, found.index - 1)];
  return found;
}

function dockedTarget(state: LayoutState, paneId: PaneId | undefined): PaneNode | undefined {
  if (paneId === undefined) return dockedPanes(state)[0];
  const pane = paneOf(state, paneId);
  if (!pane) throw new Error(`dock: unknown pane ${paneId}`);
  return pane;
}

export function activeTabOf(state: LayoutState, paneId: PaneId): TabId | undefined {
  const pane = paneOf(state, paneId);
  return pane?.active;
}

export function getTab(state: LayoutState, tabId: TabId): TabRecord | undefined {
  return state.tabs[tabId];
}

export function findTab(state: LayoutState, tabId: TabId): { tab: TabRecord; pane: PaneNode; index: number } | undefined {
  const tab = state.tabs[tabId];
  if (!tab) return undefined;
  for (const node of Object.values(state.nodes)) {
    if (node.type !== 'pane') continue;
    const index = node.tabs.indexOf(tabId);
    if (index >= 0) return { tab, pane: node, index };
  }
  return undefined;
}

/** The first tab showing `kind`, searching docked panes in order and then floats bottom to top. */
export function findTabByKind(state: LayoutState, kind: string): ReturnType<typeof findTab> {
  return findTabMatching(state, record => record.kind === kind);
}

/** The first tab of `kind` showing exactly `content`, wherever it is: docked or floating. Opening
 * content that is already open reveals this tab instead of adding another. */
export function findTabByContent(state: LayoutState, kind: string, content: string): ReturnType<typeof findTab> {
  return findTabMatching(state, record => record.kind === kind && record.content === content);
}

function findTabMatching(state: LayoutState, shows: (record: TabRecord) => boolean): ReturnType<typeof findTab> {
  for (const pane of [...dockedPanes(state), ...floatPanes(state)]) {
    const tabId = pane.tabs.find(id => state.tabs[id] !== undefined && shows(state.tabs[id]!));
    if (tabId !== undefined) return { tab: state.tabs[tabId]!, pane, index: pane.tabs.indexOf(tabId) };
  }
  return undefined;
}

export function paneHasKind(state: LayoutState, paneId: PaneId, kind: string): boolean {
  const pane = paneOf(state, paneId);
  return Boolean(pane?.tabs.some(tabId => state.tabs[tabId]?.kind === kind));
}

export function dockedPanes(state: LayoutState): PaneNode[] {
  const panes: PaneNode[] = [];
  const visit = (id: NodeId | undefined): void => {
    const node = id ? state.nodes[id] : undefined;
    if (!node) return;
    if (node.type === 'pane') panes.push(node);
    else node.children.forEach(visit);
  };
  visit(state.rootId);
  return panes;
}

export function floatPanes(state: LayoutState): PaneNode[] {
  return state.floats.flatMap(id => {
    const pane = paneOf(state, id);
    return pane?.host === 'float' ? [pane] : [];
  });
}

/** The pane whose strip end is the surface's top-right corner: the rightmost pane of the top row. */
export function topRightPaneId(state: LayoutState): PaneId | undefined {
  let node = state.rootId ? state.nodes[state.rootId] : undefined;
  while (node?.type === 'split') node = state.nodes[node.direction === 'row' ? node.children.at(-1)! : node.children[0]!];
  return node?.type === 'pane' ? node.id : undefined;
}

function mutate(state: LayoutState, op: DockOp): void {
  switch (op.type) {
    case 'open-tab': {
      const pane = dockedTarget(state, op.paneId);
      if (!pane) {
        const id = freshId<PaneId>(state, 'p-');
        const root = paneNode(id, 'docked');
        root.tabs = [addRecord(state, op.kind, op.tabId, op.content)];
        root.active = root.tabs[0];
        state.nodes[id] = root;
        state.rootId = id;
        return;
      }
      if (pane.host === 'float' && pane.tabs.length) throw new Error(`dock: float pane ${pane.id} holds one tab`);
      insertTab(pane, addRecord(state, op.kind, op.tabId, op.content), op.index, op.activate !== false);
      return;
    }
    case 'close-tab': {
      if (!findTab(state, op.tabId)) return;
      const { pane } = removeTab(state, op.tabId);
      delete state.tabs[op.tabId];
      settlePane(state, pane.id);
      return;
    }
    case 'activate-tab': {
      const pane = paneOf(state, op.paneId);
      if (pane?.tabs.includes(op.tabId)) pane.active = op.tabId;
      return;
    }
    case 'move-tab': {
      const found = findTab(state, op.tabId);
      if (!found) return;
      if (op.floatRect) {
        removeTab(state, op.tabId);
        settlePane(state, found.pane.id);
        const id = freshId<PaneId>(state, 'p-');
        const pane = paneNode(id, 'float');
        pane.tabs = [op.tabId];
        pane.active = op.tabId;
        state.nodes[id] = pane;
        state.floats.push(id);
        state.rects[id] = { ...op.floatRect };
        return;
      }
      if (op.toPaneId !== undefined && op.toPaneId !== found.pane.id) {
        const target = dockedTarget(state, op.toPaneId);
        if (!target) throw new Error(`dock: cannot move into ${op.toPaneId}`);
        if (target.host === 'float') throw new Error(`dock: float pane ${target.id} holds one tab`);
        removeTab(state, op.tabId);
        insertTab(target, op.tabId, op.index, true);
        settlePane(state, found.pane.id);
        return;
      }
      const from = found.index;
      const index = Math.max(0, Math.min(op.index ?? found.pane.tabs.length - 1, found.pane.tabs.length - 1));
      found.pane.tabs.splice(from, 1);
      found.pane.tabs.splice(index, 0, op.tabId);
      found.pane.active = op.tabId;
      return;
    }
    case 'split-pane': {
      const pane = paneOf(state, op.paneId);
      if (!pane || pane.host !== 'docked') throw new Error(`dock: cannot split ${op.paneId}`);
      const seed = op.seed;
      if (!seed || (!seed.tabId && !seed.kind)) throw new Error('dock: split-pane needs a seed');
      const direction = op.direction ?? 'row';
      const newPaneId = freshId<PaneId>(state, 'p-');
      const created = paneNode(newPaneId, 'docked');
      state.nodes[newPaneId] = created;
      const parent = parentOf(state, pane.id);
      const order = op.side === 'after' ? [pane.id, newPaneId] : [newPaneId, pane.id];
      if (!parent) {
        const splitId = freshId<SplitId>(state, 's-');
        state.nodes[splitId] = splitNode(splitId, direction, order, [0.5, 0.5]);
        state.rootId = splitId;
      } else if (parent.parent.direction === direction) {
        // Same axis: the new pane shares the split pane's weight.
        const weight = parent.parent.sizes[parent.index]!;
        parent.parent.children.splice(parent.index + (op.side === 'after' ? 1 : 0), 0, newPaneId);
        parent.parent.sizes = normalize([...parent.parent.sizes.slice(0, parent.index), weight / 2, weight / 2, ...parent.parent.sizes.slice(parent.index + 1)]);
      } else {
        const splitId = freshId<SplitId>(state, 's-');
        state.nodes[splitId] = splitNode(splitId, direction, order, [0.5, 0.5]);
        parent.parent.children[parent.index] = splitId;
      }
      if (seed.tabId !== undefined) {
        const moved = removeTab(state, seed.tabId);
        created.tabs = [seed.tabId];
        created.active = seed.tabId;
        if (!moved.pane.tabs.length) {
          if (op.refillKind !== undefined) insertTab(moved.pane, addRecord(state, op.refillKind, undefined, undefined), 0, true);
          else forgetPane(state, moved.pane.id);
        }
      } else {
        insertTab(created, addRecord(state, seed.kind!, undefined, seed.content), 0, true);
      }
      return;
    }
    case 'close-pane': {
      forgetPane(state, op.paneId);
      return;
    }
    case 'resize-split': {
      const split = state.nodes[op.splitId];
      if (!split || split.type !== 'split') return;
      if (op.sizes.length !== split.children.length) throw new Error('dock: size count mismatch');
      split.sizes = normalize(op.sizes);
      return;
    }
    case 'float-pane': {
      const pane = paneOf(state, op.paneId);
      if (!pane || pane.host !== 'docked') throw new Error(`dock: cannot float ${op.paneId}`);
      const parent = parentOf(state, pane.id);
      if (!parent) state.rootId = undefined;
      else {
        parent.parent.children.splice(parent.index, 1);
        parent.parent.sizes.splice(parent.index, 1);
        parent.parent.sizes = normalize(parent.parent.sizes);
        collapse(state, parent.parent.id);
      }
      pane.host = 'float';
      state.floats.push(pane.id);
      state.rects[pane.id] = { ...op.rect };
      return;
    }
    case 'move-float': {
      if (state.rects[op.paneId]) state.rects[op.paneId] = { ...op.rect };
      return;
    }
    case 'focus-float': {
      if (state.floats.includes(op.paneId)) state.floats = [...state.floats.filter(item => item !== op.paneId), op.paneId];
      return;
    }
    case 'close-float': {
      if (paneOf(state, op.paneId)?.host === 'float') forgetPane(state, op.paneId);
      return;
    }
    case 'dock-pane': {
      const pane = paneOf(state, op.paneId);
      if (!pane || pane.host !== 'float') return;
      const target = dockedTarget(state, op.toPaneId);
      if (target?.host === 'float') throw new Error(`dock: float pane ${target.id} holds one tab`);
      const [tabId] = pane.tabs;
      delete state.rects[pane.id];
      state.floats = state.floats.filter(item => item !== pane.id);
      delete state.nodes[pane.id];
      if (!tabId) return;
      if (target) insertTab(target, tabId, undefined, true);
      else {
        // Nothing is docked: the float becomes the root pane and keeps its tab's identity.
        pane.host = 'docked';
        state.nodes[pane.id] = pane;
        state.rootId = pane.id;
      }
      return;
    }
  }
}

/** Applies one operation. Throws on structurally impossible input; callers treat that
 * as a bug, not a user-facing failure. An op with nothing to do returns an equal state. */
export function applyOp(previous: LayoutState, op: DockOp): LayoutState {
  const state = clone(previous);
  mutate(state, op);
  return state;
}

/** Applies operations as one step: the result is the state after all of them, in order. */
export function applyOps(previous: LayoutState, ops: readonly DockOp[]): LayoutState {
  const state = clone(previous);
  for (const op of ops) mutate(state, op);
  return state;
}

/** Refill rule, run after every committed change: the ops that give an emptied docked tree
 * content again, or nothing. The kit never invents a tab on its own. */
export type DockSettle = (state: LayoutState) => readonly DockOp[] | undefined;

export interface DockController {
  readonly state: LayoutState;
  apply(ops: readonly DockOp[] | DockOp): void;
  beginGesture(): void;
  endGesture(): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  reset(state: LayoutState): void;
}

export interface HistoryRecord {
  state: LayoutState;
  past: LayoutState[];
  future: LayoutState[];
  gestureStart: LayoutState | undefined;
}
export type HistoryAction =
  | { t: 'apply'; ops: readonly DockOp[] }
  | { t: 'begin' }
  | { t: 'end' }
  | { t: 'undo' }
  | { t: 'redo' }
  | { t: 'reset'; state: LayoutState };

function commit(state: LayoutState, ops: readonly DockOp[], settle: DockSettle | undefined): LayoutState {
  const next = applyOps(state, ops);
  const refill = settle?.(next);
  return refill?.length ? applyOps(next, refill) : next;
}

const sameLayout = (left: LayoutState, right: LayoutState): boolean => JSON.stringify(left) === JSON.stringify(right);

const isOps = (ops: readonly DockOp[] | DockOp): ops is readonly DockOp[] => Array.isArray(ops);

/** One history step. Outside a gesture every apply records one undo entry; inside one, begin
 * and end coalesce everything between them. A step that changes nothing records nothing. */
export function reduceHistory(record: HistoryRecord, action: HistoryAction, settle?: DockSettle): HistoryRecord {
  switch (action.t) {
    case 'apply': {
      if (!action.ops.length) return record;
      const next = commit(record.state, action.ops, settle);
      if (sameLayout(next, record.state)) return record;
      if (record.gestureStart) return { ...record, state: next };
      return { state: next, past: [...record.past, record.state], future: [], gestureStart: undefined };
    }
    case 'begin':
      return record.gestureStart ? record : { ...record, gestureStart: record.state };
    case 'end':
      return record.gestureStart && !sameLayout(record.gestureStart, record.state)
        ? { state: record.state, past: [...record.past, record.gestureStart], future: [], gestureStart: undefined }
        : { ...record, gestureStart: undefined };
    case 'undo': {
      const previous = record.past.at(-1);
      return previous
        ? { state: previous, past: record.past.slice(0, -1), future: [...record.future, record.state], gestureStart: undefined }
        : record;
    }
    case 'redo': {
      const next = record.future.at(-1);
      return next
        ? { state: next, past: [...record.past, record.state], future: record.future.slice(0, -1), gestureStart: undefined }
        : record;
    }
    case 'reset':
      return { state: commit(action.state, [], settle), past: [], future: [], gestureStart: undefined };
  }
}

const initialRecord = (state: LayoutState): HistoryRecord => ({ state, past: [], future: [], gestureStart: undefined });

/** Snapshot history over a layout, with the settle rule applied on adoption and after every step. */
export function createDockHistory(initial: LayoutState, options?: { settle?: DockSettle }): DockController {
  let record = reduceHistory(initialRecord(initial), { t: 'reset', state: initial }, options?.settle);
  return {
    get state() { return record.state; },
    apply(ops) { record = reduceHistory(record, { t: 'apply', ops: isOps(ops) ? ops : [ops] }, options?.settle); },
    beginGesture() { record = reduceHistory(record, { t: 'begin' }, options?.settle); },
    endGesture() { record = reduceHistory(record, { t: 'end' }, options?.settle); },
    undo() { record = reduceHistory(record, { t: 'undo' }, options?.settle); },
    redo() { record = reduceHistory(record, { t: 'redo' }, options?.settle); },
    canUndo() { return record.past.length > 0; },
    canRedo() { return record.future.length > 0; },
    reset(state) { record = reduceHistory(record, { t: 'reset', state }, options?.settle); },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === 'string' && /^[pst]-./.test(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Checks a layout read back from untrusted storage — every saved field, node membership,
 * tab records, selection and ids — and returns a copy safe to adopt, with the id counter raised
 * above every id it carries. Anything malformed rejects the whole layout: the embedder then
 * starts from `emptyLayout()` instead of rendering a half-restored dock. */
export function validateLayout(value: unknown): LayoutState | undefined {
  if (!isRecord(value) || !isRecord(value.nodes) || !isRecord(value.tabs) || !isRecord(value.rects)) return undefined;
  if (!Array.isArray(value.floats) || !value.floats.every(isId)) return undefined;
  if (!Number.isInteger(value.counter) || (value.counter as number) < 1) return undefined;
  const nodes = value.nodes;
  const tabs = value.tabs;
  const referenced = new Set<string>();
  for (const [id, node] of Object.entries(nodes)) {
    if (!isRecord(node) || node.id !== id) return undefined;
    if (node.type === 'pane') {
      const { host, active } = node;
      const members: unknown = node.tabs;
      if (host !== 'docked' && host !== 'float') return undefined;
      if (!Array.isArray(members) || !members.every(isId) || new Set(members).size !== members.length) return undefined;
      // An expanded dock never shows an empty pane, and a float is exactly one tab.
      if (host === 'float' ? members.length !== 1 : members.length === 0) return undefined;
      if (active !== undefined && !members.some(member => member === active)) return undefined;
      for (const tabId of members) {
        if (referenced.has(tabId)) return undefined;
        referenced.add(tabId);
      }
    } else if (node.type === 'split') {
      const children: unknown = node.children;
      const sizes: unknown = node.sizes;
      if ((node.direction !== 'row' && node.direction !== 'column') || !Array.isArray(children) || children.length < 2 || !children.every(isId)) return undefined;
      if (new Set(children).size !== children.length) return undefined;
      if (!Array.isArray(sizes) || sizes.length !== children.length || !sizes.every(size => finite(size) && size > 0)) return undefined;
    } else return undefined;
  }
  // The docked tree is connected from its root and holds every docked pane and every split.
  const reached = new Set<string>();
  const visit = (id: string): boolean => {
    if (reached.has(id)) return false;
    const node = nodes[id];
    if (!isRecord(node)) return false;
    reached.add(id);
    if (node.type === 'pane') return node.host === 'docked';
    return (node.children as string[]).every(visit);
  };
  if (value.rootId !== undefined && (!isId(value.rootId) || !visit(value.rootId))) return undefined;
  for (const [id, node] of Object.entries(nodes)) {
    if (isRecord(node) && (node.type === 'split' || node.host === 'docked') && !reached.has(id)) return undefined;
  }
  const floats = value.floats as string[];
  if (new Set(floats).size !== floats.length) return undefined;
  if (Object.values(nodes).filter(node => isRecord(node) && node.host === 'float').length !== floats.length) return undefined;
  const rects = value.rects;
  for (const paneId of floats) {
    const pane = nodes[paneId];
    const rect = rects[paneId];
    if (!isRecord(pane) || pane.type !== 'pane' || pane.host !== 'float') return undefined;
    if (!isRecord(rect) || !finite(rect.x) || !finite(rect.y) || !finite(rect.width) || !finite(rect.height) || rect.width <= 0 || rect.height <= 0) return undefined;
  }
  // Every referenced tab has exactly one record, and every record is referenced once.
  if (referenced.size !== Object.keys(tabs).length) return undefined;
  for (const [id, tab] of Object.entries(tabs)) {
    if (!isRecord(tab) || tab.id !== id || typeof tab.kind !== 'string' || !referenced.has(id)) return undefined;
    // Content is whatever a kind shows, bounded so a saved layout cannot carry a document.
    if (tab.content !== undefined && (typeof tab.content !== 'string' || tab.content.length === 0 || tab.content.length > TAB_CONTENT_LIMIT)) return undefined;
  }
  const state = clone(value as unknown as LayoutState);
  state.rects = Object.fromEntries(floats.map(paneId => [paneId, state.rects[paneId]!]));
  // A counter below an id it carries would reissue that id on the next mint.
  let highest = state.counter - 1;
  for (const id of [...Object.keys(state.nodes), ...Object.keys(state.tabs)]) {
    const serial = /^[pst]-(\d+)$/.exec(id);
    if (serial) highest = Math.max(highest, Number(serial[1]));
  }
  state.counter = highest + 1;
  return state;
}
