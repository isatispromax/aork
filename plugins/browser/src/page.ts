/** One browser tab's page: its address history, the frame showing it, and what the toolbar can
 * tell about both. Adapted from deepseek-harness `packages/client/ui-sidebar-browser` (IframeImpl,
 * IframePresentation and BrowserController; MIT, Copyright (c) 2026 DeepSeek). Nothing here reads
 * across origins: the frame reports only that it loaded or failed, for the request whose document
 * it was showing. */
import { BrowserNavigation, currentBrowserTarget, type BrowserTabState } from './navigation.js';
import { parseBrowserAddress, type BrowserAddressFailure, type BrowserTarget } from './url.js';
import styles from './browser.module.css';

/** Fixed frame policy. Scripts, forms, popups and its own origin are granted; navigating the
 * workbench on top and downloading are not. */
export const WEB_BROWSER_SANDBOX = 'allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox';

/** A loading failure, optionally carrying the browser's own diagnostic. */
export interface BrowserLoadError {
  readonly code: number | undefined;
  readonly description: string | undefined;
}

/** What the toolbar shows. */
export interface BrowserPageState {
  /** The address asked for last; nothing before the first navigation. */
  readonly target: BrowserTarget | undefined;
  /** Whether that is still the address showing. A page that navigated itself went somewhere
   * this panel cannot read. */
  readonly address: 'empty' | 'requested' | 'unknown';
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly error: BrowserLoadError | undefined;
  /** Whether the frame policy is enforced. The choice lasts for this page's lifetime only. */
  readonly sandboxed: boolean;
  /** The address an earlier visit saved, offered back until this visit navigates. */
  readonly restoreTarget: BrowserTarget | undefined;
  /** Why the last address-bar value was refused. */
  readonly addressFailure: BrowserAddressFailure | undefined;
  /** Changes whenever another address shows or a command runs, so the address bar can reset its draft. */
  readonly addressRevision: number;
}

/** The state of a page nothing has been asked of. */
export const IDLE_BROWSER_PAGE_STATE: BrowserPageState = Object.freeze({
  target: undefined, address: 'empty', loading: false, canGoBack: false, canGoForward: false,
  error: undefined, sandboxed: true, restoreTarget: undefined, addressFailure: undefined, addressRevision: 0,
});

const sameState = (left: BrowserPageState, right: BrowserPageState): boolean => left === right
  || (left.target === right.target && left.address === right.address && left.loading === right.loading
    && left.canGoBack === right.canGoBack && left.canGoForward === right.canGoForward && left.error === right.error
    && left.sandboxed === right.sandboxed && left.restoreTarget === right.restoreTarget
    && left.addressFailure === right.addressFailure && left.addressRevision === right.addressRevision);

export interface BrowserPageOptions {
  /** Navigation saved for this tab by an earlier visit. It is offered back, never loaded on its own. */
  readonly initial: BrowserTabState | undefined;
  /** Receives the tab's navigation after every change. */
  persist(state: BrowserTabState): void;
}

/** Owns one tab's navigation and its frame. The React body mounts and unmounts; the page outlives
 * both while its tab is open, so switching tabs and back reloads the page but keeps the history. */
export class BrowserPage {
  private readonly navigation: BrowserNavigation;
  private checkpoint: BrowserTabState | undefined;
  private value: BrowserPageState;
  private readonly listeners = new Set<() => void>();
  private sandboxed = true;
  private error: BrowserLoadError | undefined;
  private addressFailure: BrowserAddressFailure | undefined;
  private addressRevision = 0;
  private shownUrl: string | undefined;
  private host: HTMLElement | undefined;
  private element: HTMLIFrameElement | undefined;
  /** The document the frame is to show. Only a navigation sets it: a request that was merely
   * saved by an earlier visit is offered back and waits to be asked for. */
  private showing: BrowserTabState['request'];
  /** Whether this visit has navigated. Until it has, the address an earlier visit saved is offered
   * back rather than loaded, whatever the history already holds. */
  private started = false;
  private rendered = false;
  private disposed = false;

  /** @param options - Saved navigation and where to keep it.
   * @param applicationOrigin - Origin of the workbench document, which is never embedded. */
  constructor(private readonly options: BrowserPageOptions, private readonly applicationOrigin: string) {
    this.navigation = new BrowserNavigation(options.initial);
    this.checkpoint = options.initial;
    this.value = this.snapshot();
  }

  /** @returns Immutable state for the toolbar. */
  getSnapshot = (): BrowserPageState => this.value;
  /** @param listener - Told that the state changed. @returns Unsubscribes. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Attach the page inside a committed container. A body mounted again — its tab was switched
   * back to, or it moved between the dock and a floating window — reloads the page it was
   * showing; the history and the address are kept. A page this visit has not navigated yet shows
   * nothing, whatever an earlier visit saved.
   * @param host - The container to draw in.
   * @returns Detaches the page without ending it. */
  mount(host: HTMLElement | null): () => void {
    if (host === null) return () => { /* nothing was attached */ };
    this.drop();
    this.host = host;
    if (this.rendered) this.load(this.navigation.reload());
    else this.render();
    return () => {
      if (this.host !== host) return;
      this.drop();
      this.host = undefined;
    };
  }

  /** Navigate to an address-bar value. A value that is refused is reported, not loaded; the
   * address already showing is reloaded rather than added to the history a second time. */
  loadUrl(value: string): void {
    if (this.disposed) return;
    const parsed = parseBrowserAddress(value, this.applicationOrigin);
    if (!parsed.ok) {
      // The draft stays as typed so it can be corrected: a refusal does not reset the address bar.
      this.addressFailure = parsed.reason;
      this.publish();
      return;
    }
    const showing = currentBrowserTarget(this.navigation.snapshot)?.url === parsed.target.url;
    this.command();
    this.load(showing ? this.navigation.reload() : this.navigation.navigate(parsed.target));
  }

  /** Load the address an earlier visit saved. Nothing loads it on its own. */
  restore(): void {
    const target = this.value.restoreTarget;
    if (target !== undefined) this.loadUrl(target.url);
  }
  /** Show the preceding entry. */
  goBack(): void { this.move(() => this.navigation.back()); }
  /** Show the following entry. */
  goForward(): void { this.move(() => this.navigation.forward()); }
  /** Reload the selected entry, or restore the saved address when nothing else is showing. */
  reload(): void {
    if (this.disposed) return;
    if (this.value.restoreTarget !== undefined) this.restore();
    else this.move(() => this.navigation.reload());
  }
  /** Enforce or lift the frame policy. A page already showing is embedded again under the new one. */
  setSandbox(enabled: boolean): void {
    if (this.disposed || enabled === this.sandboxed) return;
    this.sandboxed = enabled;
    if (this.value.target === undefined) { this.publish(); return; }
    this.move(() => this.navigation.reload());
  }

  /** Release the frame and stop reporting. The saved navigation is left as it is. */
  dispose(): void {
    this.disposed = true;
    this.drop();
    this.host = undefined;
    this.listeners.clear();
  }

  private move(plan: () => BrowserTabState['request']): void {
    if (this.disposed) return;
    this.command();
    this.load(plan());
  }

  /** Every accepted command clears a refusal and resets the address bar's draft. */
  private command(): void {
    this.addressFailure = undefined;
    this.addressRevision++;
  }

  private load(request: BrowserTabState['request']): void {
    if (request === undefined || this.disposed) return;
    this.error = undefined;
    this.started = true;
    this.showing = request;
    this.publish();
    this.render();
  }

  private render(): void {
    const request = this.showing;
    const host = this.host;
    if (request === undefined || host === undefined) return;
    this.drop();
    const element = document.createElement('iframe');
    element.className = styles.frame ?? '';
    element.src = request.target.url;
    element.title = request.target.title;
    element.referrerPolicy = 'no-referrer';
    element.dataset.browserFrame = 'iframe';
    if (this.sandboxed) element.setAttribute('sandbox', WEB_BROWSER_SANDBOX);
    element.addEventListener('load', () => { if (this.element === element) this.loaded(request.revision); });
    element.addEventListener('error', () => { if (this.element === element) this.failed(request.revision); });
    this.element = element;
    this.rendered = true;
    host.append(element);
  }

  private loaded(revision: number): void {
    if (this.disposed) return;
    this.navigation.frameLoaded(revision);
    this.publish();
  }

  /** Only the current request's failure is shown: a frame that has since been replaced no longer speaks. */
  private failed(revision: number): void {
    if (this.disposed || this.navigation.snapshot.request?.revision !== revision) return;
    this.error = { code: undefined, description: undefined };
    this.publish();
  }

  private drop(): void {
    this.element?.remove();
    this.element = undefined;
  }

  private snapshot(): BrowserPageState {
    const state = this.navigation.snapshot;
    const target = currentBrowserTarget(state);
    const url = target?.url;
    if (url !== this.shownUrl) {
      // Another address is showing, so a refusal of the previous one no longer applies.
      this.shownUrl = url;
      this.addressFailure = undefined;
      this.addressRevision++;
    }
    return {
      target,
      address: target === undefined ? 'empty' : state.navigation.status === 'unknown' ? 'unknown' : 'requested',
      loading: state.navigation.status === 'loading' && this.error === undefined,
      canGoBack: this.navigation.canGoBack,
      canGoForward: this.navigation.canGoForward,
      error: this.error,
      sandboxed: this.sandboxed,
      restoreTarget: this.started ? undefined : currentBrowserTarget(this.checkpoint),
      addressFailure: this.addressFailure,
      addressRevision: this.addressRevision,
    };
  }

  private publish(): void {
    const state = this.navigation.snapshot;
    this.options.persist(state);
    this.checkpoint = state;
    const next = this.snapshot();
    if (sameState(next, this.value)) return;
    this.value = next;
    for (const listener of this.listeners) listener();
  }
}
