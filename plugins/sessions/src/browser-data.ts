import { useMemo, useSyncExternalStore } from 'react';
import type { UiRuntime } from '@aork/sdk/client';
import { workspaceOverviewSchema, type WorkspaceOverview } from '@aork/contracts/workspace';
import { pendingIndexSchema, type PendingIndex } from '@aork/contracts/interaction';
import { unreadPageSchema, type UnreadPage } from '@aork/contracts/workbench';
import { sessionsProjectionSchema, type SessionsProjection } from '@aork/contracts/session';

/** What every Session row reads: the Session projection, pending interactions, unread replies and
 * the Workspace list (group names). Each is absent until its first snapshot lands. */
export interface BrowserData {
  projection: SessionsProjection | undefined;
  pending: PendingIndex | undefined;
  unread: UnreadPage | undefined;
  workspaces: WorkspaceOverview | undefined;
  /** The Session projection's own failure; the rows stay drawn from the last good value. */
  error: string;
}

type Stop = () => void | Promise<void>;
interface Entry { snapshot: BrowserData; listeners: Set<() => void>; readers: number; stops: Stop[] }

const entries = new WeakMap<UiRuntime, Entry>();
const empty: BrowserData = { projection: undefined, pending: undefined, unread: undefined, workspaces: undefined, error: '' };

function entryOf(runtime: UiRuntime): Entry {
  let entry = entries.get(runtime);
  if (!entry) { entry = { snapshot: empty, listeners: new Set(), readers: 0, stops: [] }; entries.set(runtime, entry); }
  return entry;
}

/** The four sources every Session row reads. The Workspace browser mounts a rows view per group;
 * without one shared subscription set each would poll the same snapshots on its own. */
function start(runtime: UiRuntime, entry: Entry): void {
  const set = (patch: Partial<BrowserData>) => { entry.snapshot = { ...entry.snapshot, ...patch }; for (const listener of entry.listeners) listener(); };
  // Optional sources leave the last value in place: an absent plugin is not a rows failure.
  const optional = { error() { /* presentation only */ } };
  entry.stops = [
    runtime.observeSnapshot<SessionsProjection>('sessions.overview', {}, {
      next(value) { set({ projection: sessionsProjectionSchema.parse(value), error: '' }); },
      error(failure) { set({ error: failure.message }); },
    }, { owners: ['sessions'] }),
    runtime.observeSnapshot<PendingIndex>('interactions.pendingIndex', {}, {
      next(value) { set({ pending: pendingIndexSchema.parse(value) }); }, ...optional,
    }, { owners: ['interactions'] }),
    runtime.observeSnapshot<UnreadPage>('workbench.unread', {}, {
      next(value) { set({ unread: unreadPageSchema.parse(value) }); }, ...optional,
    }, { owners: ['workbench'] }),
    runtime.subscribe<WorkspaceOverview>('workspace.overview', {
      next(value) { set({ workspaces: workspaceOverviewSchema.parse(value) }); },
      // The Workspace browser reports its own list failures.
      error() { /* presentation only */ },
    }, { intervalMs: 1000 }),
  ];
}

function subscribe(runtime: UiRuntime, listener: () => void): () => void {
  const entry = entryOf(runtime);
  entry.readers += 1;
  entry.listeners.add(listener);
  // The set starts with the first reader and stops when the last one leaves.
  if (entry.stops.length === 0) start(runtime, entry);
  return () => {
    entry.listeners.delete(listener);
    entry.readers -= 1;
    if (entry.readers === 0) { for (const stop of entry.stops.splice(0)) void stop(); entry.snapshot = empty; }
  };
}

/** The shared browser data of one runtime; its readers re-render on every snapshot. */
export function useBrowserData(runtime: UiRuntime): BrowserData {
  // Stable per runtime: a fresh subscribe or snapshot function every render would resubscribe after
  // every snapshot and the rows would never keep one.
  const { subscribeTo, read } = useMemo(() => ({ subscribeTo: (listener: () => void) => subscribe(runtime, listener), read: () => entryOf(runtime).snapshot }), [runtime]);
  return useSyncExternalStore(subscribeTo, read, read);
}
