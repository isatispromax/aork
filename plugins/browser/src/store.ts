/** Per-Session browser navigation, kept in localStorage with one record per open browser tab.
 * A record is adopted only when it validates whole; anything else is dropped on its own. */
import { MAX_BROWSER_HISTORY, type BrowserTabState } from './navigation.js';
import { isBrowserTarget, type BrowserAddressFailure } from './url.js';

const STORAGE = 'aork.browser.v1';
const FAILURES: readonly BrowserAddressFailure[] = ['empty', 'invalid', 'protocol', 'credentials', 'application-origin'];
const STATUSES: readonly string[] = ['loading', 'known', 'unknown'];
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Whether a value read back from storage is a tab's navigation exactly as the panel writes one. */
export function parseTabState(value: unknown): BrowserTabState | undefined {
  if (!object(value) || !Array.isArray(value.entries) || value.entries.length > MAX_BROWSER_HISTORY) return undefined;
  if (!value.entries.every(isBrowserTarget)) return undefined;
  // The selected entry: -1 before any navigation, else one of the entries.
  const index = value.index;
  if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < -1 || index >= value.entries.length) return undefined;
  const navigation = value.navigation;
  if (!object(navigation)) return undefined;
  if (navigation.status !== 'empty' && !(STATUSES.includes(navigation.status as string) && count(navigation.revision))) return undefined;
  const request = value.request;
  let opened: BrowserTabState['request'];
  if (request === undefined) opened = undefined;
  else {
    if (!object(request) || !count(request.revision) || !isBrowserTarget(request.target)) return undefined;
    const { revision, target } = request;
    opened = { revision, target };
  }
  const failure = value.failure;
  if (failure !== undefined && !FAILURES.includes(failure as BrowserAddressFailure)) return undefined;
  return {
    entries: value.entries,
    index,
    request: opened,
    navigation: navigation.status === 'empty'
      ? { status: 'empty' }
      : { status: navigation.status as 'loading' | 'known' | 'unknown', revision: navigation.revision as number },
    failure: failure === undefined ? undefined : failure as BrowserAddressFailure,
  };
}

interface BrowserStore { readonly byTab: Record<string, BrowserTabState> }
const EMPTY: BrowserStore = { byTab: {} };
// What storage could not hold stays here for the life of the page.
const memory = new Map<string, BrowserStore>();
const keyFor = (sessionId: string | null): string => `${STORAGE}.${sessionId ?? 'default'}`;

function load(sessionId: string | null): BrowserStore {
  const key = keyFor(sessionId);
  const cached = memory.get(key);
  if (cached) return cached;
  let store = EMPTY;
  try {
    const raw = localStorage.getItem(key);
    const saved: unknown = raw ? JSON.parse(raw) : undefined;
    if (object(saved) && object(saved.byTab)) {
      const byTab: Record<string, BrowserTabState> = {};
      for (const [tab, state] of Object.entries(saved.byTab)) {
        const valid = parseTabState(state);
        if (valid && tab.length <= 1024) byTab[tab] = valid;
      }
      store = { byTab };
    }
  } catch { /* unreadable or unavailable storage: the page keeps its navigation in memory */ }
  memory.set(key, store);
  return store;
}

function save(sessionId: string | null, store: BrowserStore): void {
  const key = keyFor(sessionId);
  memory.set(key, store);
  try { localStorage.setItem(key, JSON.stringify(store)); }
  catch { /* storage unavailable: the navigation stays in memory */ }
}

/** The navigation saved for one open browser tab of a Session. */
export function readTabState(sessionId: string | null, tab: string): BrowserTabState | undefined {
  return load(sessionId).byTab[tab];
}
/** Keep the navigation of one open browser tab of a Session. */
export function writeTabState(sessionId: string | null, tab: string, state: BrowserTabState): void {
  save(sessionId, { byTab: { ...load(sessionId).byTab, [tab]: state } });
}
/** Drop the navigation of a browser tab that closed. */
export function forgetTabState(sessionId: string | null, tab: string): void {
  const { [tab]: _closed, ...byTab } = load(sessionId).byTab;
  save(sessionId, { byTab });
}
