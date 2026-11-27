import { describe, expect, it } from 'vitest';
import { BrowserNavigation, emptyBrowserTabState, MAX_BROWSER_HISTORY } from '../plugins/browser/src/navigation.js';
import type { BrowserTabState } from '../plugins/browser/src/navigation.js';
import { isBrowserTarget, MAX_BROWSER_URL_LENGTH, parseBrowserAddress } from '../plugins/browser/src/url.js';
import { parseTabState } from '../plugins/browser/src/store.js';

const ORIGIN = 'http://127.0.0.1:6688';
/** Where an address resolves, or why it was refused. */
function resolve(address: string, applicationOrigin = ORIGIN): { url: string; title: string } | { refused: string } {
    const parsed = parseBrowserAddress(address, applicationOrigin);
    return parsed.ok ? { url: parsed.target.url, title: parsed.target.title } : { refused: parsed.reason };
}

describe('browser panel addresses', () => {
    it('accepts HTTP and HTTPS, supplies the scheme, and names the host', () => {
        expect(resolve('example.com')).toEqual({ url: 'https://example.com/', title: 'example.com' });
        expect(resolve('  http://example.com/a?b=1#c  ')).toEqual({ url: 'http://example.com/a?b=1#c', title: 'example.com' });
        // A host with a port is not read as a scheme.
        expect(resolve('localhost:3000/x')).toEqual({ url: 'https://localhost:3000/x', title: 'localhost' });
        expect(resolve('[::1]:8080/')).toMatchObject({ title: '[::1]' });
    });

    it('refuses what it will not embed, each with its own reason', () => {
        expect(parseBrowserAddress('', ORIGIN)).toEqual({ ok: false, reason: 'empty' });
        expect(parseBrowserAddress('   ', ORIGIN)).toEqual({ ok: false, reason: 'empty' });
        expect(parseBrowserAddress('http://', ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
        expect(parseBrowserAddress('not a url', ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
        expect(parseBrowserAddress(`https://example.com/${'a'.repeat(MAX_BROWSER_URL_LENGTH)}`, ORIGIN)).toEqual({ ok: false, reason: 'invalid' });
        for (const address of ['file:///etc/hosts', 'javascript:alert(1)', 'data:text/html,hi', 'blob:https://example.com/1', 'about:blank', 'ftp://example.com/']) {
            expect(parseBrowserAddress(address, ORIGIN), address).toEqual({ ok: false, reason: 'protocol' });
        }
        expect(parseBrowserAddress('https://user:secret@example.com/', ORIGIN)).toEqual({ ok: false, reason: 'credentials' });
    });

    it('never embeds the workbench itself, wherever it is served, but allows other ports on the same host', () => {
        expect(parseBrowserAddress(ORIGIN, ORIGIN)).toEqual({ ok: false, reason: 'application-origin' });
        expect(parseBrowserAddress(`${ORIGIN}/?token=x#workspace=1`, ORIGIN)).toEqual({ ok: false, reason: 'application-origin' });
        expect(parseBrowserAddress('http://127.0.0.1:9999/', ORIGIN).ok).toBe(true);
        // Without a known application origin nothing is refused on that ground; an opaque one grants nothing.
        expect(parseBrowserAddress(ORIGIN).ok).toBe(true);
        expect(parseBrowserAddress(ORIGIN, 'null').ok).toBe(true);
        expect(parseBrowserAddress(ORIGIN, 'not an origin').ok).toBe(true);
    });

    it('recognises a saved target only when it is exactly what the parser produces', () => {
        const target = parseBrowserAddress('https://example.com/a', ORIGIN);
        expect(target.ok && isBrowserTarget(target.target)).toBe(true);
        expect(isBrowserTarget({ kind: 'https', url: 'https://example.com/a', title: 'example.com' })).toBe(true);
        for (const value of [null, 'x', {}, { kind: 'https', url: 'https://example.com/a' }, { kind: 'http', url: 'https://example.com/a', title: 'example.com' }, { kind: 'https', url: 'file:///etc/hosts', title: 'example.com' }, { kind: 'https', url: 'https://example.com/a', title: 'other.com' }]) {
            expect(isBrowserTarget(value), JSON.stringify(value)).toBe(false);
        }
    });
});

describe('browser panel history', () => {
    const target = (host: string) => ({ kind: 'https' as const, url: `https://${host}/`, title: host });
    const url = (state: BrowserTabState | undefined): string | undefined => BrowserNavigation.current(state)?.url;

    it('starts empty and grows by navigations, each with its own revision', () => {
        const history = new BrowserNavigation();
        expect(history.snapshot).toEqual(emptyBrowserTabState());
        expect(history.back()).toBeUndefined();
        expect(history.forward()).toBeUndefined();
        expect(history.reload()).toBeUndefined();
        const first = history.navigate(target('one.example'));
        expect(first).toEqual({ revision: 1, target: target('one.example') });
        expect(history.snapshot.navigation).toEqual({ status: 'loading', revision: 1 });
        expect(history.canGoBack).toBe(false);
        expect(history.navigate(target('two.example')).revision).toBe(2);
        expect(history.snapshot.entries.map(entry => entry.title)).toEqual(['one.example', 'two.example']);
        expect(history.snapshot.index).toBe(1);
        expect(history.canGoBack).toBe(true);
        expect(history.canGoForward).toBe(false);
    });

    it('walks back and forward, and a navigation from the past drops the branch it replaces', () => {
        const history = new BrowserNavigation();
        for (const host of ['one', 'two', 'three']) history.navigate(target(`${host}.example`));
        expect(history.back()).toMatchObject({ revision: 4, target: target('two.example') });
        expect(url(history.snapshot)).toBe('https://two.example/');
        expect(history.canGoForward).toBe(true);
        expect(history.forward()).toMatchObject({ revision: 5, target: target('three.example') });
        history.back();
        history.navigate(target('new.example'));
        expect(history.snapshot.entries.map(entry => entry.title)).toEqual(['one.example', 'two.example', 'new.example']);
        expect(history.canGoForward).toBe(false);
    });

    it('reloads the selected entry without touching the history', () => {
        const history = new BrowserNavigation();
        history.navigate(target('one.example'));
        history.navigate(target('two.example'));
        const before = history.snapshot;
        expect(history.reload()).toMatchObject({ revision: 3, target: target('two.example') });
        expect(history.snapshot.entries).toEqual(before.entries);
        expect(history.snapshot.index).toBe(1);
    });

    it('keeps the address of a request through its first load and gives it up on a second', () => {
        const history = new BrowserNavigation();
        const request = history.navigate(target('one.example'));
        // A load for some other request is not this document's.
        history.frameLoaded(request.revision + 1);
        expect(history.snapshot.navigation.status).toBe('loading');
        history.frameLoaded(request.revision);
        expect(history.snapshot.navigation).toEqual({ status: 'known', revision: request.revision });
        // The page navigated itself: where it went cannot be read, so the history cannot be trusted either.
        history.frameLoaded(request.revision);
        expect(history.snapshot.navigation).toEqual({ status: 'unknown', revision: request.revision });
        expect(history.canGoBack).toBe(false);
        expect(history.canGoForward).toBe(false);
        history.navigate(target('two.example'));
        history.frameLoaded(2);
        history.back();
        expect(history.snapshot.navigation).toEqual({ status: 'loading', revision: 3 });
        // The first entry again: forward is open, and there is nothing earlier to go back to.
        expect(history.canGoForward).toBe(true);
        expect(history.canGoBack).toBe(false);
    });

    it('forgets the oldest entries past its bound', () => {
        const history = new BrowserNavigation();
        for (let n = 0; n < MAX_BROWSER_HISTORY + 10; n++) history.navigate(target(`host${n}.example`));
        expect(history.snapshot.entries).toHaveLength(MAX_BROWSER_HISTORY);
        expect(history.snapshot.entries[0]?.title).toBe('host10.example');
        expect(history.snapshot.index).toBe(MAX_BROWSER_HISTORY - 1);
    });
});

describe('browser panel saved navigation', () => {
    it('adopts a record the panel wrote and rejects anything else', () => {
        const history = new BrowserNavigation();
        history.navigate({ kind: 'http', url: 'http://one.example/', title: 'one.example' });
        history.frameLoaded(1);
        const saved = JSON.parse(JSON.stringify(history.snapshot));
        expect(parseTabState(saved)).toEqual(saved);
        expect(parseTabState(emptyBrowserTabState())).toEqual(emptyBrowserTabState());
        const broken = (change: (copy: Record<string, any>) => void): unknown => { const copy = JSON.parse(JSON.stringify(saved)); change(copy); return parseTabState(copy); };
        expect(broken(copy => { copy.index = 5; })).toBeUndefined();
        expect(broken(copy => { copy.index = -2; })).toBeUndefined();
        expect(broken(copy => { copy.entries[0].url = 'file:///etc/hosts'; })).toBeUndefined();
        expect(broken(copy => { copy.navigation.status = 'elsewhere'; })).toBeUndefined();
        expect(broken(copy => { copy.navigation.revision = -1; })).toBeUndefined();
        expect(broken(copy => { copy.request = { revision: 1, target: { kind: 'https' } }; })).toBeUndefined();
        expect(broken(copy => { copy.failure = 'nope'; })).toBeUndefined();
        for (const value of [null, 7, 'x', [], {}, { entries: [] }]) expect(parseTabState(value)).toBeUndefined();
    });
});
