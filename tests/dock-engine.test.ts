import { describe, expect, it } from 'vitest';
import {
    activeTabOf, applyOp, applyOps, createDockHistory, dockedPanes, emptyLayout, findTab, findTabByContent, findTabByKind, floatPanes,
    paneHasKind, reduceHistory, TAB_CONTENT_LIMIT, topRightPaneId, validateLayout,
} from '../packages/dock/src/engine.js';
import type { DockOp, LayoutState, PaneId, SplitId, TabId } from '../packages/dock/src/engine.js';

const tab = (name: string): TabId => `t-${name}` as TabId;

/** A root pane holding one tab of `kind`. */
function seeded(kind: string, name = kind): { state: LayoutState; rootPane: PaneId } {
    const state = applyOp(emptyLayout(), { type: 'open-tab', kind, tabId: tab(name) });
    return { state, rootPane: dockedPanes(state)[0]!.id };
}
/** A left pane holding Files beside a right pane holding a Terminal, split left to right. */
function twoPanes(): { state: LayoutState; left: PaneId; right: PaneId } {
    const { state, rootPane } = seeded('files', 'a');
    const split = applyOp(state, { type: 'split-pane', paneId: rootPane, side: 'after', seed: { kind: 'terminal' } });
    const [left, right] = dockedPanes(split);
    return { state: split, left: left!.id, right: right!.id };
}
/** The kinds a pane shows, docked or floating. */
const kindsIn = (state: LayoutState, paneId: PaneId): string[] => {
    const pane = [...dockedPanes(state), ...floatPanes(state)].find(item => item.id === paneId)!;
    return pane.tabs.map(id => state.tabs[id]!.kind);
};
const kinds = (state: LayoutState): string[] => Object.values(state.tabs).map(item => item.kind);

describe('dock engine', () => {
    it('opens the first tab as the root pane and further tabs into it', () => {
        const state = applyOps(emptyLayout(), [{ type: 'open-tab', kind: 'files' }, { type: 'open-tab', kind: 'terminal' }]);
        expect(dockedPanes(state)).toHaveLength(1);
        const root = dockedPanes(state)[0]!;
        expect(root.tabs.map(id => state.tabs[id])).toEqual([{ id: root.tabs[0], kind: 'files' }, { id: root.tabs[1], kind: 'terminal' }]);
        expect(activeTabOf(state, root.id)).toBe(root.tabs[1]);
    });

    it('names and places tabs on request, and never reissues an id', () => {
        const { state, rootPane } = seeded('files', 'a');
        const named = applyOps(state, [
            { type: 'open-tab', kind: 'files', tabId: tab('c') },
            { type: 'open-tab', kind: 'files', tabId: tab('b'), index: 1, activate: false },
        ]);
        expect(dockedPanes(named)[0]!.tabs).toEqual([tab('a'), tab('b'), tab('c')]);
        expect(activeTabOf(named, rootPane)).toBe(tab('c'));
        expect(() => applyOp(state, { type: 'open-tab', kind: 'files', tabId: tab('a') })).toThrow(/already exists/);
        // A counter carried below the ids it holds must skip past the taken one.
        const next = applyOp({ ...named, counter: 1 }, { type: 'open-tab', kind: 'files' });
        const minted = dockedPanes(next)[0]!.tabs.at(-1)!;
        expect(new Set(dockedPanes(next)[0]!.tabs).size).toBe(4);
        expect(next.tabs[minted]?.kind).toBe('files');
    });

    it('splitting the root yields two weighted panes and resizing normalizes', () => {
        const { state, rootPane } = seeded('files', 'a');
        const split = applyOp(state, { type: 'split-pane', paneId: rootPane, side: 'after', seed: { kind: 'terminal' } });
        const [left, right] = dockedPanes(split);
        expect(left!.id).toBe(rootPane);
        expect(kindsIn(split, right!.id)).toEqual(['terminal']);
        expect(split.nodes[split.rootId!]).toMatchObject({ type: 'split', direction: 'row', sizes: [0.5, 0.5] });
        expect(topRightPaneId(split)).toBe(right!.id);
        const resized = applyOp(split, { type: 'resize-split', splitId: split.rootId as SplitId, sizes: [0.7, 0.7] });
        expect(resized.nodes[resized.rootId!]).toMatchObject({ sizes: [0.5, 0.5] });
    });

    it('a split before its pane puts the new pane first, and a same-axis split shares the weight', () => {
        const { state, left, right } = twoPanes();
        const third = applyOp(state, { type: 'split-pane', paneId: left, side: 'before', seed: { kind: 'guide' } });
        expect(dockedPanes(third).map(pane => pane.id).slice(1)).toEqual([left, right]);
        expect(third.nodes[third.rootId!]).toMatchObject({ sizes: [0.25, 0.25, 0.5] });
        expect(topRightPaneId(third)).toBe(right);
    });

    it('a moved seed refills the pane it empties, or lets that pane collapse', () => {
        const { state, rootPane } = seeded('files', 'a');
        // The only tab dragged onto its own pane's edge: the tab takes the new pane.
        const refilled = applyOp(state, { type: 'split-pane', paneId: rootPane, side: 'after', seed: { tabId: tab('a') }, refillKind: 'guide' });
        expect(dockedPanes(refilled).map(pane => kindsIn(refilled, pane.id))).toEqual([['guide'], ['files']]);
        expect(dockedPanes(refilled)[0]!.id).toBe(rootPane);
        // Without a refill the vacated pane is discarded, so the dragged tab simply moves.
        const collapsed = applyOp(state, { type: 'split-pane', paneId: rootPane, side: 'after', seed: { tabId: tab('a') } });
        expect(dockedPanes(collapsed)).toHaveLength(1);
        expect(kindsIn(collapsed, dockedPanes(collapsed)[0]!.id)).toEqual(['files']);
    });

    it('splitting moves a tab arriving from another pane and discards the pane it leaves', () => {
        const { state, left, right } = twoPanes();
        const arriving = findTabByKind(state, 'terminal')!.tab.id;
        const split = applyOp(state, { type: 'split-pane', paneId: left, side: 'after', seed: { tabId: arriving } });
        expect(dockedPanes(split).map(pane => kindsIn(split, pane.id))).toEqual([['files'], ['terminal']]);
        expect(dockedPanes(split).map(pane => pane.id)).not.toContain(right);
        expect(() => applyOp(state, { type: 'split-pane', paneId: left, side: 'after' })).toThrow(/needs a seed/);
    });

    it('closing a tab collapses emptied panes and can empty the layout', () => {
        const { state } = twoPanes();
        const closed = applyOp(state, { type: 'close-tab', tabId: findTabByKind(state, 'terminal')!.tab.id });
        expect(dockedPanes(closed)).toHaveLength(1);
        expect(closed.rootId).toBe(dockedPanes(closed)[0]!.id);
        expect(closed.nodes[closed.rootId!]).toMatchObject({ type: 'pane' });
        expect(kinds(closed)).toEqual(['files']);
        const empty = applyOp(closed, { type: 'close-tab', tabId: tab('a') });
        expect(empty.rootId).toBeUndefined();
        expect(Object.keys(empty.nodes)).toHaveLength(0);
        expect(Object.keys(empty.tabs)).toHaveLength(0);
    });

    it('closing one of several tabs hands selection to its neighbour', () => {
        const { state, rootPane } = seeded('files', 'a');
        const three = applyOps(state, [
            { type: 'open-tab', kind: 'files', tabId: tab('b'), activate: false },
            { type: 'open-tab', kind: 'files', tabId: tab('c'), activate: false },
        ]);
        expect(activeTabOf(three, rootPane)).toBe(tab('a'));
        expect(activeTabOf(applyOp(three, { type: 'close-tab', tabId: tab('a') }), rootPane)).toBe(tab('b'));
        expect(activeTabOf(applyOp(three, { type: 'close-tab', tabId: tab('b') }), rootPane)).toBe(tab('a'));
        expect(activeTabOf(applyOp(three, { type: 'activate-tab', paneId: rootPane, tabId: tab('c') }), rootPane)).toBe(tab('c'));
    });

    it('reorders a tab inside its pane', () => {
        const { state, rootPane } = seeded('files', 'a');
        const three = applyOps(state, [
            { type: 'open-tab', kind: 'files', tabId: tab('b'), activate: false },
            { type: 'open-tab', kind: 'files', tabId: tab('c'), activate: false },
        ]);
        const moved = applyOp(three, { type: 'move-tab', tabId: tab('c'), index: 0 });
        expect(dockedPanes(moved)[0]!.tabs).toEqual([tab('c'), tab('a'), tab('b')]);
        expect(activeTabOf(moved, rootPane)).toBe(tab('c'));
        const clamped = applyOp(three, { type: 'move-tab', tabId: tab('c'), index: 99 });
        expect(dockedPanes(clamped)[0]!.tabs).toEqual([tab('a'), tab('b'), tab('c')]);
    });

    it('moves tabs between panes and floats a tab dropped outside', () => {
        const { state, left, right } = twoPanes();
        const floated = applyOp(state, { type: 'move-tab', tabId: tab('a'), floatRect: { x: 10, y: 10, width: 400, height: 300 } });
        expect(floatPanes(floated)).toHaveLength(1);
        expect(findTab(floated, tab('a'))!.pane.host).toBe('float');
        // Moving a tab out of a one-tab pane discards that pane.
        expect(dockedPanes(floated).map(pane => pane.id)).toEqual([right]);
        const dockedBack = applyOp(floated, { type: 'move-tab', tabId: tab('a'), toPaneId: right, index: 0 });
        expect(floatPanes(dockedBack)).toHaveLength(0);
        expect(dockedBack.nodes[right]).toMatchObject({ tabs: [tab('a'), findTabByKind(dockedBack, 'terminal')!.tab.id], active: tab('a') });
        expect(dockedBack.nodes[left]).toBeUndefined();
        expect(Object.keys(dockedBack.rects)).toHaveLength(0);
    });

    it('floats and re-docks a whole pane, and focuses floats in order', () => {
        const { state, left } = twoPanes();
        const floated = applyOp(state, { type: 'float-pane', paneId: left, rect: { x: 0, y: 0, width: 300, height: 200 } });
        expect(floated.floats).toEqual([left]);
        expect(dockedPanes(floated)).toHaveLength(1);
        const second = applyOp(floated, { type: 'float-pane', paneId: dockedPanes(floated)[0]!.id, rect: { x: 40, y: 40, width: 300, height: 200 } });
        expect(second.rootId).toBeUndefined();
        expect(floatPanes(second)).toHaveLength(2);
        const focused = applyOp(second, { type: 'focus-float', paneId: second.floats[0]! });
        expect(focused.floats).toEqual([second.floats[1], second.floats[0]]);
        const moved = applyOp(focused, { type: 'move-float', paneId: focused.floats[0]!, rect: { x: 9, y: 9, width: 310, height: 210 } });
        expect(moved.rects[moved.floats[0]!]).toEqual({ x: 9, y: 9, width: 310, height: 210 });
        const closed = applyOp(focused, { type: 'close-float', paneId: focused.floats[0]! });
        expect(floatPanes(closed)).toHaveLength(1);
        expect(Object.keys(closed.nodes)).toHaveLength(1);
        // The right pane's float was the one closed, so Files remains afloat.
        expect(kinds(closed)).toEqual(['files']);
        expect(closed.floats).toEqual([left]);
    });

    it('returns a float to the dock, or makes it the root pane when nothing is docked', () => {
        const { state, left, right } = twoPanes();
        const floated = applyOp(state, { type: 'float-pane', paneId: left, rect: { x: 0, y: 0, width: 300, height: 200 } });
        const docked = applyOp(floated, { type: 'dock-pane', paneId: left });
        expect(floatPanes(docked)).toHaveLength(0);
        expect(docked.nodes[right]).toMatchObject({ host: 'docked', tabs: [expect.any(String), tab('a')], active: tab('a') });
        expect(docked.nodes[left]).toBeUndefined();
        // With the dock emptied the float keeps its tab and becomes the root pane.
        const lone = applyOp(floated, { type: 'close-tab', tabId: findTabByKind(floated, 'terminal')!.tab.id });
        expect(lone.rootId).toBeUndefined();
        const root = applyOp(lone, { type: 'dock-pane', paneId: left });
        expect(root.rootId).toBe(left);
        expect(root.floats).toEqual([]);
        expect(root.nodes[left]).toMatchObject({ host: 'docked', tabs: [tab('a')] });
        expect(root.rects[left]).toBeUndefined();
    });

    it('answers which pane holds a kind, and which pane owns the top-right corner', () => {
        const { state, left, right } = twoPanes();
        expect(findTabByKind(state, 'terminal')!.pane.id).toBe(right);
        expect(findTabByKind(state, 'files')!.pane.id).toBe(left);
        expect(findTabByKind(state, 'guide')).toBeUndefined();
        expect(paneHasKind(state, left, 'files')).toBe(true);
        expect(paneHasKind(state, left, 'terminal')).toBe(false);
        expect(topRightPaneId(state)).toBe(right);
        expect(topRightPaneId(emptyLayout())).toBeUndefined();
    });

    it('carries what a tab shows, and finds a tab by it wherever the tab is', () => {
        const { state } = seeded('terminal', 'a');
        // A tab opened without content carries no field at all, so a saved layout stays as small as before.
        expect(state.tabs[tab('a')]).toEqual({ id: tab('a'), kind: 'terminal' });
        const opened = applyOps(state, [
            { type: 'open-tab', kind: 'terminal', tabId: tab('b'), content: 'one' },
            { type: 'open-tab', kind: 'terminal', tabId: tab('c'), content: 'two' },
        ]);
        expect(dockedPanes(opened)[0]!.tabs.map(id => opened.tabs[id])).toEqual([
            { id: tab('a'), kind: 'terminal' },
            { id: tab('b'), kind: 'terminal', content: 'one' },
            { id: tab('c'), kind: 'terminal', content: 'two' },
        ]);
        expect(findTabByContent(opened, 'terminal', 'two')?.tab.id).toBe(tab('c'));
        // Another kind, or content nothing shows, is not a match; a search by kind still finds the first.
        expect(findTabByContent(opened, 'files', 'one')).toBeUndefined();
        expect(findTabByContent(opened, 'terminal', 'three')).toBeUndefined();
        expect(findTabByKind(opened, 'terminal')?.tab.id).toBe(tab('a'));
        // Content is the tab's, not the pane's: it travels into a float and back.
        const floated = applyOp(opened, { type: 'move-tab', tabId: tab('c'), floatRect: { x: 10, y: 10, width: 400, height: 300 } });
        expect(findTabByContent(floated, 'terminal', 'two')).toMatchObject({ tab: { id: tab('c'), content: 'two' }, pane: { host: 'float' } });
        const back = applyOp(floated, { type: 'dock-pane', paneId: findTabByContent(floated, 'terminal', 'two')!.pane.id });
        expect(findTabByContent(back, 'terminal', 'two')).toMatchObject({ tab: { id: tab('c'), content: 'two' }, pane: { host: 'docked' } });
    });

    it('seeds a new pane with a tab that carries its content', () => {
        const { state, rootPane } = seeded('files', 'a');
        const split = applyOp(state, { type: 'split-pane', paneId: rootPane, side: 'after', seed: { kind: 'preview', content: 'docs/a.md' } });
        const right = dockedPanes(split)[1]!;
        expect(right.tabs).toHaveLength(1);
        expect(split.tabs[right.tabs[0]!]).toMatchObject({ kind: 'preview', content: 'docs/a.md' });
        expect(right.active).toBe(right.tabs[0]);
    });

    it('round-trips undo through the snapshot history', () => {
        const history = createDockHistory(emptyLayout());
        history.apply({ type: 'open-tab', kind: 'files', tabId: tab('a') });
        history.apply({ type: 'open-tab', kind: 'files', tabId: tab('b') });
        history.apply({ type: 'split-pane', paneId: dockedPanes(history.state)[0]!.id, side: 'after', seed: { kind: 'guide' } });
        expect(dockedPanes(history.state)).toHaveLength(2);
        history.undo();
        expect(dockedPanes(history.state)).toHaveLength(1);
        history.undo();
        expect(dockedPanes(history.state)[0]!.tabs).toEqual([tab('a')]);
        history.redo();
        history.redo();
        expect(dockedPanes(history.state)).toHaveLength(2);
        expect(history.canUndo()).toBe(true);
        expect(history.canRedo()).toBe(false);
        // A new step after an undo drops the forward branch.
        history.undo();
        history.apply({ type: 'close-tab', tabId: tab('b') });
        expect(history.canRedo()).toBe(false);
        expect(kinds(history.state)).toEqual(['files']);
    });

    it('records a batch as one entry and skips steps that change nothing', () => {
        const history = createDockHistory(emptyLayout());
        history.apply([
            { type: 'open-tab', kind: 'files', tabId: tab('f') },
            { type: 'split-pane', paneId: 'p-1' as PaneId, side: 'after', seed: { kind: 'guide' } },
        ]);
        expect(dockedPanes(history.state)).toHaveLength(2);
        expect(kinds(history.state)).toEqual(['files', 'guide']);
        // One step back is the empty layout the batch started from.
        history.undo();
        expect(dockedPanes(history.state)).toHaveLength(0);
        expect(history.canUndo()).toBe(false);
        const before = history.state;
        history.apply({ type: 'close-tab', tabId: tab('missing') });
        history.apply([]);
        history.beginGesture();
        history.endGesture();
        expect(history.state).toBe(before);
        expect(history.canUndo()).toBe(false);
        expect(history.canRedo()).toBe(true);
    });

    it('coalesces a gesture into one history entry', () => {
        const history = createDockHistory(emptyLayout());
        history.apply({ type: 'open-tab', kind: 'files', tabId: tab('a') });
        history.beginGesture();
        const pane = dockedPanes(history.state)[0]!.id;
        history.apply({ type: 'float-pane', paneId: pane, rect: { x: 0, y: 0, width: 300, height: 200 } });
        for (const x of [10, 20, 30]) history.apply({ type: 'move-float', paneId: pane, rect: { x, y: x, width: 300, height: 200 } });
        history.endGesture();
        expect(floatPanes(history.state)).toHaveLength(1);
        expect(history.canUndo()).toBe(true);
        history.undo();
        expect(floatPanes(history.state)).toHaveLength(0);
        expect(dockedPanes(history.state)).toHaveLength(1);
        // A gesture that never changed anything records nothing.
        const undoable = history.canUndo();
        const settled = history.state;
        history.beginGesture();
        history.apply({ type: 'move-float', paneId: 'p-missing' as PaneId, rect: { x: 1, y: 1, width: 300, height: 200 } });
        history.endGesture();
        expect(history.state).toBe(settled);
        expect(history.canUndo()).toBe(undoable);
    });

    it('the settle rule refills an emptied dock and folds into the same history step', () => {
        const settle = (state: LayoutState): DockOp[] | undefined => state.rootId ? undefined : [{ type: 'open-tab', kind: 'guide' }];
        // Adoption applies it too: an empty saved layout opens on its default page.
        const history = createDockHistory(emptyLayout(), { settle });
        expect(kinds(history.state)).toEqual(['guide']);
        expect(history.canUndo()).toBe(false);
        history.apply({ type: 'open-tab', kind: 'files', tabId: tab('f') });
        const guide = findTabByKind(history.state, 'guide')!.tab.id;
        // Closing every tab lands on the default page again, as one step.
        history.apply([{ type: 'close-tab', tabId: tab('f') }, { type: 'close-tab', tabId: guide }]);
        expect(dockedPanes(history.state)).toHaveLength(1);
        expect(kinds(history.state)).toEqual(['guide']);
        expect(history.canUndo()).toBe(true);
        history.undo();
        expect(kinds(history.state)).toEqual(['guide', 'files']);
        history.redo();
        expect(kinds(history.state)).toEqual(['guide']);
        // A dock that still shows something is left alone.
        history.apply({ type: 'close-tab', tabId: findTabByKind(history.state, 'guide')!.tab.id });
        expect(kinds(history.state)).toEqual(['guide']);
    });

    it('a replaced layout is settled on adoption as well', () => {
        const settle = (state: LayoutState): DockOp[] | undefined => state.rootId ? undefined : [{ type: 'open-tab', kind: 'guide' }];
        const next = reduceHistory({ state: emptyLayout(), past: [], future: [], gestureStart: undefined }, { t: 'reset', state: emptyLayout() }, settle);
        expect(kinds(next.state)).toEqual(['guide']);
        expect(next.past).toEqual([]);
    });

    it('ignores unknown tabs and panes instead of corrupting state, and refuses impossible input', () => {
        const { state, rootPane } = seeded('files', 'a');
        expect(applyOp(state, { type: 'close-tab', tabId: tab('missing') })).toEqual(state);
        expect(applyOp(state, { type: 'resize-split', splitId: 's-missing' as SplitId, sizes: [1] })).toEqual(state);
        expect(applyOp(state, { type: 'activate-tab', paneId: rootPane, tabId: tab('missing') })).toEqual(state);
        expect(applyOp(state, { type: 'dock-pane', paneId: rootPane })).toEqual(state);
        expect(() => applyOp(state, { type: 'open-tab', kind: 'x', paneId: 'p-missing' as PaneId })).toThrow(/unknown pane/);
        expect(() => applyOp(twoPanes().state, { type: 'split-pane', paneId: 'p-missing' as PaneId, side: 'after', seed: { kind: 'x' } })).toThrow(/cannot split/);
        expect(() => applyOp(state, { type: 'move-tab', tabId: tab('a'), toPaneId: 'p-missing' as PaneId })).toThrow(/unknown pane/);
        const floated = applyOp(twoPanes().state, { type: 'float-pane', paneId: rootPane, rect: { x: 0, y: 0, width: 300, height: 200 } });
        expect(() => applyOp(floated, { type: 'open-tab', kind: 'x', paneId: rootPane })).toThrow(/holds one tab/);
    });

    it('validates a persisted layout and rejects anything malformed wholesale', () => {
        const { state, left } = twoPanes();
        const adopted = validateLayout(JSON.parse(JSON.stringify({ ...state, counter: 1 })));
        expect(adopted).not.toBeUndefined();
        expect(dockedPanes(adopted!)).toHaveLength(2);
        // Raised above the highest id it carries (s-3, t-4), so the next mint is t-5.
        expect(adopted!.counter).toBe(5);
        const floated = applyOp(state, { type: 'float-pane', paneId: left, rect: { x: 0, y: 0, width: 300, height: 200 } });
        expect(validateLayout(JSON.parse(JSON.stringify(floated)))?.floats).toEqual([left]);
        const broken = (change: (copy: Record<string, any>) => void, base: LayoutState = state) => {
            const copy = JSON.parse(JSON.stringify(base));
            change(copy);
            return validateLayout(copy);
        };
        expect(broken(copy => { delete copy.tabs[Object.keys(copy.tabs)[0]!]; })).toBeUndefined();
        expect(broken(copy => { copy.tabs['t-orphan'] = { id: 't-orphan', kind: 'files' }; })).toBeUndefined();
        expect(broken(copy => { copy.tabs['t-4'].kind = 7; })).toBeUndefined();
        // Content is bounded: empty, non-string or oversized content rejects the whole layout.
        expect(broken(copy => { copy.tabs['t-a'].content = ''; })).toBeUndefined();
        expect(broken(copy => { copy.tabs['t-a'].content = 7; })).toBeUndefined();
        expect(broken(copy => { copy.tabs['t-a'].content = 'x'.repeat(TAB_CONTENT_LIMIT + 1); })).toBeUndefined();
        const carried = applyOp(state, { type: 'open-tab', kind: 'files', content: 'x'.repeat(TAB_CONTENT_LIMIT) });
        const adoptedContent = validateLayout(JSON.parse(JSON.stringify(carried)));
        expect(adoptedContent && Object.values(adoptedContent.tabs).map(item => item.content)).toContain('x'.repeat(TAB_CONTENT_LIMIT));
        expect(broken(copy => { copy.rootId = 'p-missing'; })).toBeUndefined();
        expect(broken(copy => { copy.rootId = 'p1'; })).toBeUndefined();
        expect(broken(copy => { copy.nodes['p-1'].active = 't-missing'; })).toBeUndefined();
        expect(broken(copy => { copy.nodes['p-1'].tabs = []; })).toBeUndefined();
        expect(broken(copy => { copy.nodes['p-2'].tabs.push('t-a'); })).toBeUndefined();
        expect(broken(copy => { copy.nodes['s-3'].children.push('p-1'); })).toBeUndefined();
        expect(broken(copy => { copy.nodes['s-3'].sizes = [0.5, 0, 0.5]; })).toBeUndefined();
        expect(broken(copy => { copy.nodes['p-9'] = { type: 'pane', id: 'p-9', host: 'docked', tabs: ['t-a'], active: 't-a' }; })).toBeUndefined();
        expect(broken(copy => { copy.counter = 0; })).toBeUndefined();
        expect(broken(copy => { delete copy.rects['p-1']; }, floated)).toBeUndefined();
        expect(broken(copy => { copy.floats = []; }, floated)).toBeUndefined();
        expect(broken(copy => { copy.rects['p-1'].width = -1; }, floated)).toBeUndefined();
        for (const value of [null, 7, 'layout', {}, { ...state, floats: {} }, { ...state, tabs: [] }]) expect(validateLayout(value)).toBeUndefined();
    });
});
