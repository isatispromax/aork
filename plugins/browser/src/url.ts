/** Address parsing for the browser panel's HTTP(S) allowlist.
 * Adapted from deepseek-harness `packages/client/ui-sidebar-browser/src/client/browser/url.ts`
 * (MIT, Copyright (c) 2026 DeepSeek). */

/** Maximum accepted address length; this bounds persisted navigation state. */
export const MAX_BROWSER_URL_LENGTH = 16 * 1024;

/** A normalized navigation target. `title` is the host the page lives on. */
export interface BrowserTarget {
  readonly kind: 'https' | 'http';
  readonly url: string;
  readonly title: string;
}

/** Why an address was refused before navigation. */
export type BrowserAddressFailure = 'empty' | 'invalid' | 'protocol' | 'credentials' | 'application-origin';

/** Result of parsing an address-bar value. */
export type BrowserAddressResult =
  | { readonly ok: true; readonly target: BrowserTarget }
  | { readonly ok: false; readonly reason: BrowserAddressFailure };

/**
 * Parse one address-bar value into the fixed protocol allowlist.
 * @param input - Address-bar or typed-open input.
 * @param applicationOrigin - Origin of the workbench document, which an embedded page must never show.
 * @returns A canonical target, or the refusal reason.
 */
export function parseBrowserAddress(input: string, applicationOrigin?: string): BrowserAddressResult {
  const trimmed = input.trim();
  if (trimmed === '') return { ok: false, reason: 'empty' };
  if (trimmed.length > MAX_BROWSER_URL_LENGTH) return { ok: false, reason: 'invalid' };
  // `host:port/path` is a host with a port, not a scheme; anything else with a scheme keeps it.
  const explicitScheme = /^[A-Za-z][A-Za-z\d+.-]*:(?!\d+(?:[/?#]|$))/u.test(trimmed);
  const candidate = explicitScheme ? trimmed : `https://${trimmed}`;
  let url: URL;
  try { url = new URL(candidate); } catch { return { ok: false, reason: 'invalid' }; }
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials' };
  if (url.protocol === 'https:' || url.protocol === 'http:') {
    if (applicationOrigin !== undefined && applicationOrigin !== 'null') {
      try {
        // The workbench's own origin has the signed-in session: embedded, a page could act as the user.
        if (url.origin === new URL(applicationOrigin).origin) return { ok: false, reason: 'application-origin' };
      } catch { /* an origin that cannot be parsed grants nothing */ }
    }
    return { ok: true, target: { kind: url.protocol === 'https:' ? 'https' : 'http', url: url.href, title: url.hostname } };
  }
  return { ok: false, reason: 'protocol' };
}

/** Whether a value read back from storage is a target exactly as the parser produces one. */
export function isBrowserTarget(value: unknown): value is BrowserTarget {
  if (!value || typeof value !== 'object') return false;
  const { kind, url, title } = value as Record<string, unknown>;
  if ((kind !== 'https' && kind !== 'http') || typeof url !== 'string' || typeof title !== 'string') return false;
  const parsed = parseBrowserAddress(url);
  return parsed.ok && parsed.target.url === url && parsed.target.kind === kind && parsed.target.title === title;
}
