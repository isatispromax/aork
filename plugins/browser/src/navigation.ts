/** The browser panel's own address history and what it can still tell about the page showing.
 * Adapted from deepseek-harness `packages/client/ui-sidebar-browser/src/client/browser/BrowserNavigation.ts`
 * and `BrowserPersistence.ts` (MIT, Copyright (c) 2026 DeepSeek). */
import type { BrowserAddressFailure, BrowserTarget } from './url.js';

/** Maximum retained navigation entries per tab. */
export const MAX_BROWSER_HISTORY = 100;

/** What the panel knows about the page its frame is showing for the current request. */
export type BrowserNavigationStatus =
  | { readonly status: 'empty' }
  | { readonly status: 'loading'; readonly revision: number }
  | { readonly status: 'known'; readonly revision: number }
  | { readonly status: 'unknown'; readonly revision: number };

/** One tab's navigation, kept in the browser per Session. */
export interface BrowserTabState {
  readonly entries: readonly BrowserTarget[];
  readonly index: number;
  readonly request: { readonly revision: number; readonly target: BrowserTarget } | undefined;
  readonly navigation: BrowserNavigationStatus;
  readonly failure: BrowserAddressFailure | undefined;
}

/** Navigation before any address has been asked for. */
export function emptyBrowserTabState(): BrowserTabState {
  return { entries: [], index: -1, request: undefined, navigation: { status: 'empty' }, failure: undefined };
}

/** The selected history entry, if the tab has one. */
export function currentBrowserTarget(state: BrowserTabState | undefined): BrowserTarget | undefined {
  return state === undefined || state.index < 0 ? undefined : state.entries[state.index];
}

/** Owns the address history and the frame's observation of its own loads. The first load for a
 * request keeps its address authoritative; another load for the same request means the page
 * navigated itself to an address the panel cannot read. */
export class BrowserNavigation {
  private value: BrowserTabState;

  /** @param initial - Navigation saved for this tab, or a fresh empty state. */
  constructor(initial: BrowserTabState = emptyBrowserTabState()) {
    this.value = initial;
  }

  /** The selected entry of a saved state; `canGoBack` and `canGoForward` likewise read one. */
  static current(state: BrowserTabState | undefined): BrowserTarget | undefined { return currentBrowserTarget(state); }
  static canGoBack(state: BrowserTabState): boolean { return state.navigation.status !== 'unknown' && state.index > 0; }
  static canGoForward(state: BrowserTabState): boolean {
    return state.navigation.status !== 'unknown' && state.index >= 0 && state.index < state.entries.length - 1;
  }

  /** Current immutable serializable state. */
  get snapshot(): BrowserTabState { return this.value; }
  /** Whether the frame can safely show the preceding entry. */
  get canGoBack(): boolean { return BrowserNavigation.canGoBack(this.value); }
  /** Whether the frame can safely show the following entry. */
  get canGoForward(): boolean { return BrowserNavigation.canGoForward(this.value); }

  /** Add a target and drop the forward branch it replaces. */
  navigate(target: BrowserTarget): NonNullable<BrowserTabState['request']> {
    const entries = [...this.value.entries.slice(0, this.value.index + 1), target];
    if (entries.length > MAX_BROWSER_HISTORY) entries.splice(0, entries.length - MAX_BROWSER_HISTORY);
    return this.request(target, { ...this.value, entries, index: entries.length - 1 });
  }

  /** Select the preceding entry, when there is one the frame can safely show. */
  back(): BrowserTabState['request'] {
    if (!this.canGoBack) return undefined;
    const index = this.value.index - 1;
    const target = this.value.entries[index] as BrowserTarget;
    return this.request(target, { ...this.value, index });
  }

  /** Select the following entry. */
  forward(): BrowserTabState['request'] {
    if (!this.canGoForward) return undefined;
    const index = this.value.index + 1;
    const target = this.value.entries[index] as BrowserTarget;
    return this.request(target, { ...this.value, index });
  }

  /** Load the selected entry again, without adding to the history. */
  reload(): BrowserTabState['request'] {
    const target = currentBrowserTarget(this.value);
    return target === undefined ? undefined : this.request(target, this.value);
  }

  /** Record a frame load for the request whose document the frame was showing. */
  frameLoaded(revision: number): void {
    const navigation = this.value.navigation;
    if (navigation.status === 'empty' || navigation.revision !== revision) return;
    if (navigation.status === 'loading') this.value = { ...this.value, navigation: { status: 'known', revision } };
    else if (navigation.status === 'known') this.value = { ...this.value, navigation: { status: 'unknown', revision } };
  }

  private request(target: BrowserTarget, basis: BrowserTabState): NonNullable<BrowserTabState['request']> {
    const request = { revision: (this.value.request?.revision ?? 0) + 1, target };
    this.value = { ...basis, request, navigation: { status: 'loading', revision: request.revision }, failure: undefined };
    return request;
  }
}
