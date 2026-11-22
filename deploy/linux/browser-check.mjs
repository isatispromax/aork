#!/usr/bin/env node
// Real-browser validation on the Mac (ticket 19).
//
// Launches real Chromium (repo's @playwright/test toolchain) against the
// Caddy HTTPS endpoint mapped onto the Mac loopback (https://localhost:8443):
//   1. opens the startup Token access link (only obtainable from the
//      service's local startup output),
//   2. verifies the signed HttpOnly SameSite=Strict Cookie is set and the
//      URL Token is cleared by the 303,
//   3. verifies the workbench UI renders authenticated,
//   4. opens the event stream WebSocket (wss://...) from inside the page
//      and receives server events after triggering a public command there.
//
// TLS note: Chromium runs with certificate errors ignored because the
// Caddy internal root CA is not imported into the macOS system keychain
// (that would need admin rights); the chain itself is verified separately
// by validate.sh with curl/openssl against the exported root certificate.
import assert from 'node:assert/strict';

const accessUrl = process.argv[2];
if (!accessUrl) { console.error('Usage: browser-check.mjs <accessUrl>'); process.exit(2); }
const { chromium } = await import('@playwright/test');

const browser = await chromium.launch();
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();

  // 1 + 2: Token link -> 303 -> cookie set, URL cleaned.
  await page.goto(accessUrl);
  const finalUrl = new URL(page.url());
  assert.equal(finalUrl.search, '', `URL token was not cleared: ${page.url()}`);
  const cookies = await context.cookies('https://localhost:8443');
  const session = cookies.find(cookie => cookie.name.startsWith('__Host-aork_session'));
  assert.ok(session, `no __Host-aork_session cookie after token exchange: ${JSON.stringify(cookies.map(cookie => cookie.name))}`);
  assert.equal(session.httpOnly, true);
  assert.equal(session.sameSite, 'Strict');
  assert.equal(session.secure, true);

  // 3: authenticated workbench renders.
  await page.waitForFunction(() => {
    const root = document.getElementById('root');
    return !!root && root.childElementCount > 0 && !root.textContent.includes('正在启动');
  }, undefined, { timeout: 30000 });
  const rendered = await page.evaluate(() => (document.getElementById('root') ?? { childElementCount: 0 }).childElementCount);

  // 4: WebSocket updates over WSS through the mapped port, with a command
  //    triggered from inside the page (browser-mediated, CSRF + Origin).
  const stream = await page.evaluate(async () => {
    const bootstrap = await (await fetch('/api/bootstrap')).json();
    if (bootstrap.access.state !== 'authenticated') throw new Error(`bootstrap not authenticated: ${JSON.stringify(bootstrap.access)}`);
    const frames = [];
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no preferencesChanged event within 20s; frames=${JSON.stringify(frames).slice(0, 300)}`)), 20000);
      window.__aorkResolve = frame => { clearTimeout(timer); resolve(frame); };
    });
    const query = `cursor=0&streamId=${encodeURIComponent(bootstrap.hostEpoch)}&graph=${encodeURIComponent(bootstrap.pluginGraphHash)}`;
    const socket = new WebSocket(`/api/events?${query}`);
    socket.onmessage = event => {
      const frame = JSON.parse(event.data);
      frames.push(frame);
      // The stream sends one bounded page at a time and waits for a client
      // ACK before reading the next page from the database.
      if (frame.kind === 'events') socket.send(JSON.stringify({ kind: 'ack', cursor: frame.cursor }));
      if (frame.kind === 'events' && frame.events.some(item => item.type === 'workbench.preferencesChanged')) window.__aorkResolve(frame);
    };
    const command = await fetch('/api/commands/workbench.savePreferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Aork-CSRF': bootstrap.access.csrfToken },
      body: JSON.stringify({ apiVersion: 1, commandVersion: 1, commandId: crypto.randomUUID(), pluginGraphHash: bootstrap.pluginGraphHash, payload: { theme: 'dark', sidebarOpen: true, inspectorOpen: true, inspectorWide: false } }),
    });
    const frame = await done;
    return { commandStatus: command.status, frameKind: frame.kind, cursor: frame.cursor, events: frame.events.map(item => item.type), url: socket.url, socketState: socket.readyState };
  });
  assert.equal(stream.commandStatus, 200, `savePreferences failed: ${JSON.stringify(stream)}`);
  assert.ok(stream.events.includes('workbench.preferencesChanged'), `preferencesChanged not delivered: ${JSON.stringify(stream)}`);
  assert.ok(stream.url.startsWith('wss://localhost:8443/api/events'), `unexpected stream url: ${stream.url}`);

  console.log(JSON.stringify({ browser: 'chromium (real browser on macOS)', tokenCleared: true, cookie: `${session.name} (HttpOnly, SameSite=Strict, Secure)`, renderedRootChildren: rendered, wssUrl: stream.url, wssFrameCursor: stream.cursor, wssEvents: stream.events }));
} finally {
  await browser.close();
}
