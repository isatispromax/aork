import { afterEach, expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bootstrap } from '@aork/sdk';
import { startHost } from '../apps/server/src/host.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() { const dataDir = await mkdtemp(join(tmpdir(), 'aork-token-')); cleanup.push(() => rm(dataDir, { recursive: true, force: true })); return { dataDir }; }
function cookie(response: Response) { return response.headers.get('set-cookie')!.split(';')[0]!; }
async function boot(url: string, session?: string): Promise<Bootstrap> { return (await fetch(`${url}/api/bootstrap`, { headers: session ? { Cookie: session } : {} })).json(); }
async function command(url: string, name: string, bootstrap: Bootstrap, session: string, payload: unknown, extra: Record<string, string> = {}) {
  return fetch(`${url}/api/commands/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url, Cookie: session, 'X-Aork-CSRF': bootstrap.access.csrfToken ?? '', ...extra }, body: JSON.stringify({ apiVersion: 1, commandId: crypto.randomUUID(), pluginGraphHash: bootstrap.pluginGraphHash, payload }) });
}
async function maintenance(dataDir: string, action: 'rotate' | 'recover') {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/server/main.mjs', 'access', action, '--data-dir', dataDir]); let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); }); child.stderr.on('data', chunk => { output += String(chunk); }); child.on('error', reject); child.on('close', code => resolve({ code, output }));
  });
}

test('a local launch-token link grants a durable signed browser session, restart rotates only the launch token, and logout revocation persists', async () => {
  const options = await fixture(); const first = await startHost({ ...options, port: 0, insecureLoopback: true }); cleanup.push(() => first.close());
  expect(new URL(first.accessUrl!).searchParams.get('token')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const initial = await fetch(`${first.url}/api/bootstrap`); expect(initial.headers.has('set-cookie')).toBe(false);
  expect((await initial.json()).access.state).toBe('unauthenticated');
  expect((await fetch(`${first.url}/api/queries/workbench.overview`)).status).toBe(401);
  const exchanged = await fetch(first.accessUrl!, { redirect: 'manual' });
  expect(exchanged.status).toBe(303); expect(exchanged.headers.get('location')).toBe('./'); expect(exchanged.headers.get('referrer-policy')).toBe('no-referrer');
  expect(exchanged.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Strict/);
  const session = cookie(exchanged); const authorized = await boot(first.url, session);
  expect(authorized.access.state).toBe('authenticated'); expect(JSON.stringify(authorized)).not.toContain(new URL(first.accessUrl!).searchParams.get('token'));
  const principal = authorized.access.identity;
  await first.close(); const restarted = await startHost({ ...options, port: Number(new URL(first.url).port) }); cleanup.push(() => restarted.close());
  expect(restarted.accessUrl).not.toBe(first.accessUrl);
  expect((await boot(restarted.url, session)).access.identity).toBe(principal);
  const stale = new URL(restarted.url); stale.search = new URL(first.accessUrl!).search;
  expect((await fetch(stale, { redirect: 'manual' })).status).toBe(401);
  const current = await boot(restarted.url, session);
  expect((await command(restarted.url, 'auth.logout', current, session, {})).status).toBe(200);
  expect((await fetch(`${restarted.url}/api/queries/workbench.overview`, { headers: { Cookie: session } })).status).toBe(401);
  await restarted.close(); const after = await startHost({ ...options, port: Number(new URL(first.url).port) }); cleanup.push(() => after.close());
  expect((await boot(after.url, session)).access.state).toBe('unauthenticated');
});

test('only exact-root token exchange is accepted, invalid links are limited, and public surfaces do not disclose the token', async () => {
  const options = await fixture(); const host = await startHost({ ...options, port: 0, insecureLoopback: true }); cleanup.push(() => host.close());
  const token = new URL(host.accessUrl!).searchParams.get('token')!;
  expect((await fetch(host.url)).status).toBe(401);
  expect((await fetch(`${host.url}/?token=bad`, { redirect: 'manual' })).status).toBe(401);
  expect((await fetch(`${host.url}/?token=${token}&token=${token}`, { redirect: 'manual' })).status).toBe(401);
  expect((await fetch(`${host.url}/api/queries/workbench.overview?token=${token}`)).status).toBe(401);
  const post = await fetch(host.accessUrl!, { method: 'POST' }); expect(post.status).not.toBe(303); expect(await post.text()).not.toContain(token);
  const optionsResponse = await fetch(`${host.url}/missing?token=${token}`, { method: 'OPTIONS' }); expect(await optionsResponse.text()).not.toContain(token);
  const head = await fetch(host.accessUrl!, { method: 'HEAD', redirect: 'manual' }); expect(head.status).not.toBe(303); expect(head.headers.has('set-cookie')).toBe(false);
  expect((await fetch(host.accessUrl!, { headers: { Origin: 'https://foreign.example' }, redirect: 'manual' })).status).toBe(403);
  const { request: httpRequest } = await import('node:http');
  const foreignHost = await new Promise<number>((resolve, reject) => { const request = httpRequest(host.accessUrl!, { headers: { Host: 'foreign.example' } }, response => { response.resume(); resolve(response.statusCode!); }); request.on('error', reject); request.end(); });
  expect(foreignHost).toBe(403);
  const exchanged = await fetch(host.accessUrl!, { redirect: 'manual' }); const session = cookie(exchanged);
  const authorized = await boot(host.url, session);
  const stale = await fetch(`${host.url}/?token=wrong`, { headers: { Cookie: session }, redirect: 'manual' }); expect(stale.status).toBe(303); expect(stale.headers.has('set-cookie')).toBe(false);
  for (const path of ['/api/bootstrap', '/api/diagnostics', '/api/queries/auth.status']) expect(await (await fetch(`${host.url}${path}`)).text()).not.toContain(token);
  const tampered = session.slice(0, -1) + (session.endsWith('A') ? 'B' : 'A'); expect((await boot(host.url, tampered)).access.state).toBe('unauthenticated');
  for (let index = 0; index < 4; index++) expect((await fetch(`${host.url}/?token=bad`, { redirect: 'manual' })).status).toBe(401);
  expect((await fetch(`${host.url}/?token=bad`, { redirect: 'manual' })).status).toBe(429);
  expect((await fetch(host.accessUrl!, { redirect: 'manual' })).status).toBe(303);
  expect(authorized.access.csrfToken).toMatch(/^[a-f0-9]{64}$/);
});

test('commands require CSRF and canonical Origin and WebSocket admission uses cookies rather than token URLs', async () => {
  const options = await fixture(); const host = await startHost({ ...options, port: 0, insecureLoopback: true }); cleanup.push(() => host.close());
  const session = cookie(await fetch(host.accessUrl!, { redirect: 'manual' })); const current = await boot(host.url, session);
  expect((await command(host.url, 'auth.logout', current, session, {}, { 'X-Aork-CSRF': '' })).status).toBe(403);
  expect((await command(host.url, 'auth.logout', current, session, {}, { Origin: 'https://foreign.example' })).status).toBe(403);
  const { connect } = await import('node:net');
  async function upgrade(origin: string, cookieHeader = '', query = '') {
    return new Promise<string>((resolve, reject) => { const target = new URL(host.url); const socket = connect(Number(target.port), target.hostname); socket.on('error', reject); socket.on('data', data => { resolve(String(data)); socket.destroy(); }); socket.on('connect', () => socket.write(`GET /api/events${query} HTTP/1.1\r\nHost: ${target.host}\r\nOrigin: ${origin}\r\nCookie: ${cookieHeader}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`)); });
  }
  expect(await upgrade('https://foreign.example', session)).toMatch(/^HTTP\/1.1 403/);
  expect(await upgrade(host.url, '', new URL(host.accessUrl!).search)).toMatch(/^HTTP\/1.1 401/);
  expect(await upgrade(host.url, session)).toMatch(/^HTTP\/1.1 426/);
});

test('production cookie policy is Secure and audience-isolated while insecure mode refuses non-loopback binding', async () => {
  const options = await fixture(); await expect(startHost({ ...options, host: '0.0.0.0', port: 0, insecureLoopback: true })).rejects.toThrow('loopback');
  const first = await startHost({ ...options, port: 0 }); cleanup.push(() => first.close());
  const firstExchange = await fetch(first.accessUrl!, { redirect: 'manual' });
  expect(firstExchange.headers.get('set-cookie')).toMatch(/^__Host-aork_session-[A-Za-z0-9_-]{43}=v1\..*; Path=\/; HttpOnly; SameSite=Strict; Secure;/);
  const firstSession = cookie(firstExchange); await first.close();
  const second = await startHost({ ...options, port: 0 }); cleanup.push(() => second.close());
  const secondSession = cookie(await fetch(second.accessUrl!, { redirect: 'manual' }));
  expect(secondSession.split('=')[0]).not.toBe(firstSession.split('=')[0]);
  expect((await boot(second.url, firstSession)).access.state).toBe('unauthenticated');
});

test('local signing-key rotation owns the instance lock and revokes cookies while preserving the stable principal', async () => {
  const options = await fixture(); const first = await startHost({ ...options, port: 0, insecureLoopback: true }); cleanup.push(() => first.close());
  const session = cookie(await fetch(first.accessUrl!, { redirect: 'manual' })); const principal = (await boot(first.url, session)).access.identity;
  expect((await maintenance(options.dataDir, 'rotate')).output).toContain('ELOCKED'); await first.close();
  const result = await maintenance(options.dataDir, 'rotate'); expect(result.code).toBe(0); expect(result.output).not.toContain('signingSecret');
  const restarted = await startHost({ ...options, port: Number(new URL(first.url).port) }); cleanup.push(() => restarted.close());
  expect((await boot(restarted.url, session)).access.state).toBe('unauthenticated');
  const newSession = cookie(await fetch(restarted.accessUrl!, { redirect: 'manual' })); expect((await boot(restarted.url, newSession)).access.identity).toBe(principal);
});

test('session capacity and anonymous churn never revoke existing browsers or make persisted authorization unstartable', async () => {
  const options = await fixture(); const first = await startHost({ ...options, port: 0, insecureLoopback: true }); cleanup.push(() => first.close());
  let oldest = '';
  for (let index = 0; index < 160; index++) { const response = await fetch(first.accessUrl!, { redirect: 'manual' }); expect(response.status).toBe(303); if (index === 0) oldest = cookie(response); }
  expect((await fetch(first.accessUrl!, { redirect: 'manual' })).status).toBe(429);
  for (let index = 0; index < 170; index++) { const response = await fetch(`${first.url}/api/bootstrap`); expect(response.headers.has('set-cookie')).toBe(false); }
  expect((await boot(first.url, oldest)).access.state).toBe('authenticated'); await first.close();
  const restarted = await startHost({ ...options, port: Number(new URL(first.url).port) }); cleanup.push(() => restarted.close()); expect((await boot(restarted.url, oldest)).access.state).toBe('authenticated');
}, 15000);

test('authentication activation failure remains closed and the separate local maintenance entry recovers a disabled provider without executing server activation', async () => {
  const { cp, readFile, writeFile } = await import('node:fs/promises');
  const options = await fixture(); const distributionDir = join(options.dataDir, 'distribution'); await cp('dist', distributionDir, { recursive: true });
  const serverPath = join(distributionDir, 'plugins/auth-single-user/0.1.0/server.js'); const original = await readFile(serverPath, 'utf8'); await writeFile(serverPath, `throw new Error('private-signing-key-fault');\n${original}`);
  const broken = await startHost({ ...options, distributionDir, port: 0, insecureLoopback: true }); cleanup.push(() => broken.close());
  expect(broken.accessUrl).toBeUndefined(); const initial = await boot(broken.url); expect(initial.access.state).toBe('unavailable'); expect(JSON.stringify(initial)).not.toContain('private-signing-key-fault'); expect((await fetch(`${broken.url}/api/queries/workbench.overview`)).status).toBe(503); await broken.close();
  const { maintainAccess } = await import('../apps/server/src/host.js');
  await expect(maintainAccess({ ...options, distributionDir, action: 'recover' })).resolves.toMatchObject({ sessionsRevoked: true });
  await writeFile(serverPath, original); // The actual faulty package must be repaired; maintenance never executes it.
  const repaired = await startHost({ ...options, distributionDir }); cleanup.push(() => repaired.close()); expect(repaired.accessUrl).toBeDefined(); expect((await fetch(repaired.accessUrl!, { redirect: 'manual' })).status).toBe(303); await repaired.close();
  const { maintainProfile } = await import('../apps/server/src/host.js'); const current = await maintainProfile({ ...options, distributionDir });
  const disabled = structuredClone(current.profile); disabled.plugins.find(plugin => plugin.id === 'auth-single-user')!.enabled = false;
  // Broken persisted selection is introduced through a distribution fixture and first boot on another real instance.
  const secondData = await fixture(); const profilePath = join(distributionDir, 'profiles/personal-server.json'); await writeFile(profilePath, JSON.stringify(disabled));
  const missing = await startHost({ ...secondData, distributionDir, port: 0, insecureLoopback: true }); cleanup.push(() => missing.close()); expect((await boot(missing.url)).access.state).toBe('unavailable'); await missing.close();
  expect((await maintenance(secondData.dataDir, 'recover')).code).toBe(0);
  const restored = await startHost(secondData); cleanup.push(() => restored.close()); expect((await fetch(restored.accessUrl!, { redirect: 'manual' })).status).toBe(303);
});

test('a business plugin cannot declare a public HTTP bypass and a live authorization exception remains closed', async () => {
  const { cp, readFile, writeFile } = await import('node:fs/promises');
  const options = await fixture(); const distributionDir = join(options.dataDir, 'distribution'); await cp('dist', distributionDir, { recursive: true });
  const path = join(distributionDir, 'plugins/workbench/0.1.0/server.js'); await writeFile(path, (await readFile(path, 'utf8')).replace(/function activate\(([^)]+)\)\s*\{/, (match, context: string) => `${match}${context}.query('fixture.public',{access:'public',execute:()=>({private:'business'})});${context}.command('fixture.public',{access:'public',execute:()=>({private:'business'})});`));
  const host = await startHost({ ...options, distributionDir, port: 0, insecureLoopback: true }); cleanup.push(() => host.close());
  const initial = await boot(host.url); expect((await fetch(`${host.url}/api/queries/fixture.public`)).status).toBe(401); expect((await command(host.url, 'fixture.public', initial, '', {})).status).toBe(401); await host.close();
  const authPath = join(distributionDir, 'plugins/auth-single-user/0.1.0/server.js'); await writeFile(authPath, (await readFile(authPath, 'utf8')).replace('inspect(request) {', 'inspect(request) { throw new Error("private-service-fault");'));
  const failed = await startHost({ ...options, distributionDir }); cleanup.push(() => failed.close()); expect((await boot(failed.url)).access.state).toBe('unavailable'); expect((await fetch(`${failed.url}/api/queries/workbench.overview`)).status).toBe(503); expect(await (await fetch(`${failed.url}/api/bootstrap`)).text()).not.toContain('private-service-fault');
});

test('Host shutdown releases its maintenance lock even when a browser connection has an unfinished request', async () => {
  const { connect } = await import('node:net');
  const options = await fixture(); const host = await startHost({ ...options, port: 0, insecureLoopback: true }); cleanup.push(() => host.close());
  const target = new URL(host.url); const socket = connect(Number(target.port), target.hostname); await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const accepted = new Promise<void>(resolve => { socket.once('data', chunk => { expect(String(chunk)).toContain('100 Continue'); resolve(); }); });
  socket.write(`POST /api/commands/auth.logout HTTP/1.1\r\nHost: ${target.host}\r\nOrigin: ${host.url}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\nExpect: 100-continue\r\n\r\n`);
  await accepted; socket.write('{');
  const closing = host.close(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const released = await Promise.race([closing.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 500); })]);
    expect(released).toBe(true);
  } finally { clearTimeout(timer); socket.destroy(); await closing; }
  expect((await maintenance(options.dataDir, 'rotate')).code).toBe(0);
});
