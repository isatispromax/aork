/** Which terminals of a Session this browser started. Kept in localStorage with the Session's
 * other browser-local state, so it survives a reload and no longer than the tab.
 *
 * A tab's terminal is found by reading its output. A read that finds nothing can mean either a
 * tab that was just opened — its terminal is to be started — or a tab restored from a saved
 * layout after the Host restarted, whose terminal is gone and is not started again on its own.
 * What tells them apart is whether this browser ever started a terminal for the tab. */

const STORAGE = 'aork.terminal.v1';
const LIMIT = 64;
const created = new Map<string, Set<string>>();
const keyFor = (sessionId: string | null): string => `${STORAGE}.${sessionId ?? 'default'}`;

function load(sessionId: string | null): Set<string> {
  const key = keyFor(sessionId);
  const cached = created.get(key);
  if (cached) return cached;
  const ids = new Set<string>();
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    if (Array.isArray(saved)) for (const id of saved.slice(0, LIMIT)) if (typeof id === 'string' && id.length <= 128) ids.add(id);
  } catch { /* unreadable or unavailable storage: this page remembers on its own */ }
  created.set(key, ids);
  return ids;
}

function save(sessionId: string | null, ids: Set<string>): void {
  try { localStorage.setItem(keyFor(sessionId), JSON.stringify([...ids].slice(-LIMIT))); }
  catch { /* storage unavailable: this page remembers on its own */ }
}

/** Whether a terminal was started for this tab. */
export function wasCreated(sessionId: string | null, id: string): boolean { return load(sessionId).has(id); }
/** Records that a terminal was started for this tab. */
export function markCreated(sessionId: string | null, id: string): void {
  const ids = load(sessionId);
  if (ids.has(id)) return;
  ids.add(id);
  save(sessionId, ids);
}
/** Forgets a tab that closed. */
export function forgetCreated(sessionId: string | null, id: string): void {
  const ids = load(sessionId);
  if (!ids.delete(id)) return;
  save(sessionId, ids);
}
