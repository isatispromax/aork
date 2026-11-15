import { afterEach, expect, test } from 'vitest';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startHost, maintainProfile } from '../apps/server/src/host.js';
import type { Bootstrap } from '@aork/sdk';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(key = true) {
  const directory = await mkdtemp(join(tmpdir(), 'aork-agents-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const distributionDir = join(directory, 'distribution'); await cp('dist', distributionDir, { recursive: true });
  const provider = join(distributionDir, 'plugins/test-agent/0.1.0'); await mkdir(provider, { recursive: true });
  await writeFile(join(provider, 'aork.plugin.json'), JSON.stringify({ manifestVersion: 1, id: 'test-agent', version: '0.1.0', sdkRange: '^0.1.0', server: 'server.js', requires: ['aork.agent.providers@1', 'aork.agent.profiles@1', 'aork.agent.credentials@1'], ui: { providers: [] } }));
  const executable = join(directory, 'controlled-acp.mjs'); await writeFile(executable, `if (process.argv[2] === '--version') console.log('1.2.0'); else process.exitCode = 2;`);
  await writeFile(join(provider, 'server.js'), `import { execFileSync } from 'node:child_process'; export function activate(context) {
    const registry = context.service('aork.agent.providers@1'); let detectionMode = 'normal';
    context.command('test.detectionMode', { access: 'authenticated', execute(payload) { detectionMode = payload.mode; return { changed: true }; } });
    const common = { launch: { executable: process.execPath, arguments: [${JSON.stringify(executable)}], protocol: 'acp-stdio' }, version: '1.2.0', parameters: [{ name: 'model', label: 'Model', type: 'string' }], parseParameters(value) { if (Object.keys(value).some(k => k !== 'model') || (value.model !== undefined && typeof value.model !== 'string')) throw new Error('invalid'); return value; } };
    registry.register({ ...common, id: 'test.acp', label: 'Controllable ACP test Provider', authentication: ['none', 'api-key', 'native-oauth'], async detect() { if (detectionMode === 'hang') return new Promise(() => {}); if (detectionMode === 'throw') throw new Error('private-provider-diagnostic-must-not-leak'); const version = execFileSync(process.execPath, [${JSON.stringify(executable)}, '--version'], { encoding: 'utf8', timeout: 1000 }).trim(); return { status: 'available', version }; } });
    registry.register({ ...common, id: 'missing.acp', label: 'Missing ACP binary', authentication: ['none'], async detect() { try { execFileSync(${JSON.stringify(join(directory, 'absent-acp'))}, ['--version'], { timeout: 1000 }); return { status: 'available', version: '1.0.0' }; } catch { return { status: 'unavailable', reason: 'binary-missing' }; } } });
    context.command('test.captureProfile', { access: 'authenticated', execute(payload) { const snapshot = context.service('aork.agent.profiles@1').snapshot(payload.id); context.state.set('snapshot', snapshot); return snapshot; } });
    context.query('test.snapshot', { access: 'authenticated', execute() { return context.state.get('snapshot'); } });
    context.query('test.credentialUsable', { access: 'authenticated', execute() { const snapshot = context.state.get('snapshot'); const value = context.service('aork.agent.credentials@1').resolveApiKey(snapshot.credentialRef, snapshot.providerId); return { usable: typeof value === 'string' && value.length > 0 }; } });
  }`);
  const masterKeyFile = join(directory, 'master.key'); if (key) await writeFile(masterKeyFile, randomBytes(32), { mode: 0o600 });
  const profile = JSON.parse(await readFile('profiles/personal-server.json', 'utf8'));
  profile.plugins.push({ id: 'test-agent', version: '0.1.0', enabled: true });
  profile.plugins.find((plugin: { id: string }) => plugin.id === 'agent-profiles').config = { masterKeyFile };
  const options = { dataDir: join(directory, 'data'), distributionDir, port: 0, insecureLoopback: true };
  await maintainProfile({ ...options, profile });
  const host = await startHost(options); cleanup.push(() => host.close());
  const exchange = await fetch(host.accessUrl!, { redirect: 'manual' }); const session = exchange.headers.get('set-cookie')!.split(';')[0]!;
  const bootstrap = await (await fetch(`${host.url}/api/bootstrap`, { headers: { Cookie: session } })).json() as Bootstrap;
  return { directory, masterKeyFile, options, host, session, bootstrap };
}
async function query(f: Awaited<ReturnType<typeof fixture>>, name = 'agents.overview') { return fetch(`${f.host.url}/api/queries/${name}`, { headers: { Cookie: f.session } }); }
async function command(f: Awaited<ReturnType<typeof fixture>>, name: string, payload: unknown, commandId = crypto.randomUUID()) { return fetch(`${f.host.url}/api/commands/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: f.host.url, Cookie: f.session, 'X-Aork-CSRF': f.bootstrap.access.csrfToken! }, body: JSON.stringify({ apiVersion: 1, commandVersion: 1, commandId, pluginGraphHash: f.bootstrap.pluginGraphHash, payload }) }); }
test('registered Providers expose detection and validated Profiles survive restart through immutable public receipts', async () => {
  const f = await fixture();
  const overview = await query(f); expect(overview.status).toBe(200);
  expect(await overview.json()).toMatchObject({ profiles: [], providers: [{ id: 'missing.acp', detection: { status: 'unavailable', reason: 'binary-missing' } }, { id: 'test.acp', detection: { status: 'available', version: '1.2.0' } }] });
  const id = crypto.randomUUID(); const payload = { name: 'Research agent', providerId: 'test.acp', parameters: { model: 'test-model' }, versionRequirement: '^1.0.0', authentication: 'none' };
  const created = await command(f, 'agents.createProfile', payload, id); expect(created.status).toBe(200); const receipt = await created.json();
  expect(receipt.result).toMatchObject({ name: 'Research agent', providerId: 'test.acp', parameters: { model: 'test-model' }, revision: 1, credentialRef: null });
  expect(await (await command(f, 'agents.createProfile', payload, id)).json()).toEqual(receipt);
  expect((await (await query(f)).json()).profiles).toHaveLength(1);
  const port = Number(new URL(f.host.url).port); await f.host.close(); f.host = await startHost({ ...f.options, port }); cleanup.push(() => f.host.close());
  expect((await (await query(f)).json()).profiles[0].profile).toEqual(receipt.result);
  expect(await (await command(f, 'agents.createProfile', payload, id)).json()).toEqual(receipt);
});

test('manual API secrets are usable only through the server broker, encrypted at rest, and absent from public projections after restart', async () => {
  const f = await fixture(); const secret = `manual-api-secret-${crypto.randomUUID()}`; const commandId = crypto.randomUUID();
  const payload = { providerId: 'test.acp', label: 'Research credential', secret };
  const response = await command(f, 'agents.storeCredential', payload, commandId); expect(response.status).toBe(200); const receipt = await response.json();
  expect(receipt.result).toMatchObject({ label: 'Research credential', kind: 'api-key' }); expect(JSON.stringify(receipt)).not.toContain(secret);
  expect(await (await command(f, 'agents.storeCredential', payload, commandId)).json()).toEqual(receipt);
  const profile = await (await command(f, 'agents.createProfile', { name: 'API agent', providerId: 'test.acp', parameters: { model: 'safe' }, versionRequirement: '^1.0.0', authentication: 'api-key', credentialRef: receipt.result.id })).json();
  expect((await command(f, 'test.captureProfile', { id: profile.result.id })).status).toBe(200);
  expect(await (await query(f, 'test.credentialUsable')).json()).toEqual({ usable: true });
  const overview = await (await query(f)).json(); expect(overview.credentials).toHaveLength(1); expect(overview.profiles[0].credentialStatus).toBe('ready');
  const events = await (await fetch(`${f.host.url}/api/events`, { headers: { Cookie: f.session } })).text();
  const publicReceipt = await (await fetch(`${f.host.url}/api/receipts/${commandId}`, { headers: { Cookie: f.session } })).text();
  for (const value of [JSON.stringify(overview), JSON.stringify(f.bootstrap), events, publicReceipt]) expect(value).not.toContain(secret);
  const { readdir } = await import('node:fs/promises');
  async function checkBytes(directory: string) { for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) await checkBytes(path); else expect((await readFile(path)).includes(Buffer.from(secret))).toBe(false); } }
  await checkBytes(f.options.dataDir);
  const port = Number(new URL(f.host.url).port); await f.host.close();
  const doctor = await maintainProfile(f.options); expect(JSON.stringify(doctor)).not.toContain(secret);
  f.host = await startHost({ ...f.options, port }); cleanup.push(() => f.host.close());
  expect(await (await query(f, 'test.credentialUsable')).json()).toEqual({ usable: true });
  expect(await (await command(f, 'agents.storeCredential', payload, commandId)).json()).toEqual(receipt);
  expect((await (await query(f)).json()).credentials).toHaveLength(1);
});

test('unusable keys fail visibly without accepting a secret and existing credentials remain recoverable after key restoration', async () => {
  const f = await fixture(false); const payload = { providerId: 'test.acp', label: 'Not accepted', secret: 'must-never-be-dropped' }; const id = crypto.randomUUID();
  expect((await (await query(f)).json()).credentialStorage.status).toBe('missing-key');
  const rejected = await command(f, 'agents.storeCredential', payload, id); expect(rejected.status).toBe(503); expect(await rejected.json()).toMatchObject({ error: { code: 'CREDENTIAL_KEY_UNAVAILABLE' } });
  expect((await (await query(f)).json()).credentials).toEqual([]);
  expect((await fetch(`${f.host.url}/api/receipts/${id}`, { headers: { Cookie: f.session } })).status).toBe(404);
  const key = randomBytes(32); await writeFile(f.masterKeyFile, key, { mode: 0o600 });
  const port = Number(new URL(f.host.url).port); await f.host.close(); f.host = await startHost({ ...f.options, port }); cleanup.push(() => f.host.close());
  const stored = await command(f, 'agents.storeCredential', payload, id); expect(stored.status).toBe(200); const ref = (await stored.json()).result.id;
  const saved = await (await command(f, 'agents.createProfile', { name: 'Recoverable', providerId: 'test.acp', parameters: {}, versionRequirement: '*', authentication: 'api-key', credentialRef: ref })).json();
  await f.host.close(); await writeFile(f.masterKeyFile, randomBytes(32)); f.host = await startHost({ ...f.options, port }); cleanup.push(() => f.host.close());
  expect((await (await query(f)).json()).profiles[0]).toMatchObject({ availability: 'unavailable', credentialStatus: 'unreadable', reason: 'credential-unavailable' });
  const reuse = await command(f, 'agents.createProfile', { name: 'Rejected', providerId: 'test.acp', parameters: {}, versionRequirement: '*', authentication: 'api-key', credentialRef: ref }); expect(reuse.status).toBe(503); expect(await reuse.json()).toMatchObject({ error: { code: 'CREDENTIAL_UNREADABLE' } });
  await f.host.close(); await writeFile(f.masterKeyFile, key); f.host = await startHost({ ...f.options, port }); cleanup.push(() => f.host.close());
  expect((await (await query(f)).json()).profiles[0]).toMatchObject({ profile: { id: saved.result.id }, availability: 'available', credentialStatus: 'ready' });
});

test('profile validation rejects arbitrary commands and broken references; editing keeps prior snapshots and receipts intact', async () => {
  const f = await fixture(); const input = { name: 'Original', providerId: 'test.acp', parameters: { model: 'old' }, versionRequirement: '^1.0.0', authentication: 'none' };
  for (const payload of [{ ...input, command: 'sh -c unsafe' }, { ...input, parameters: { command: 'sh -c unsafe' } }, { ...input, providerId: 'absent' }, { ...input, versionRequirement: 'not-semver' }, { ...input, authentication: 'api-key', credentialRef: crypto.randomUUID() }]) expect((await command(f, 'agents.createProfile', payload)).status).toBeGreaterThanOrEqual(400);
  expect((await (await query(f)).json()).profiles).toEqual([]);
  const created = await (await command(f, 'agents.createProfile', input)).json();
  const captured = await (await command(f, 'test.captureProfile', { id: created.result.id })).json();
  const edited = await command(f, 'agents.editProfile', { ...input, id: created.result.id, expectedRevision: 1, name: 'Edited', parameters: { model: 'new' } }); expect(edited.status).toBe(200); expect((await edited.json()).result).toMatchObject({ revision: 2, parameters: { model: 'new' } });
  expect(await (await query(f, 'test.snapshot')).json()).toEqual(captured);
  expect((await command(f, 'agents.editProfile', { ...input, id: created.result.id, expectedRevision: 1 })).status).toBe(409);
  const missing = await (await command(f, 'agents.createProfile', { ...input, name: 'Missing binary', providerId: 'missing.acp' })).json();
  expect((await (await query(f)).json()).profiles.find((row: { profile: { id: string } }) => row.profile.id === missing.result.id)).toMatchObject({ availability: 'unavailable', reason: 'binary-missing' });
  const native = await (await command(f, 'agents.createProfile', { ...input, name: 'Native login pending', authentication: 'native-oauth' })).json();
  const { stat } = await import('node:fs/promises'); expect((await stat(native.result.stateDirectory)).mode & 0o077).toBe(0);
  expect((await (await query(f)).json()).profiles.find((row: { profile: { id: string } }) => row.profile.id === native.result.id)).toMatchObject({ availability: 'unavailable', credentialStatus: 'native-directory-only', reason: 'native-authentication-required' });
});

test('server-only master key configuration is absent from bootstrap and maintenance diagnostics', async () => {
  const f = await fixture(); const key = await readFile(f.masterKeyFile);
  const bootstrap = JSON.stringify(f.bootstrap);
  for (const privateValue of ['masterKeyFile', f.masterKeyFile, key.toString('hex'), key.toString('base64')]) expect(bootstrap).not.toContain(privateValue);
  await f.host.close(); const doctor = JSON.stringify(await maintainProfile(f.options));
  for (const privateValue of ['masterKeyFile', f.masterKeyFile, key.toString('hex'), key.toString('base64')]) expect(doctor).not.toContain(privateValue);
});


test('Provider detection failures are bounded and expose only a sanitized unavailable reason', async () => {
  const f = await fixture();
  await command(f, 'test.detectionMode', { mode: 'throw' });
  let overview = await (await query(f)).json(); expect(overview.providers.find((provider: { id: string }) => provider.id === 'test.acp').detection).toEqual({ status: 'unavailable', reason: 'provider-failed' }); expect(JSON.stringify(overview)).not.toContain('private-provider-diagnostic');
  await command(f, 'test.detectionMode', { mode: 'hang' });
  overview = await (await query(f)).json(); expect(overview.providers.find((provider: { id: string }) => provider.id === 'test.acp').detection).toEqual({ status: 'unavailable', reason: 'provider-failed' });
}, 7000);

test('local access recovery preserves credential and Profile receipt identity without exposing secrets', async () => {
  const f = await fixture(); const commandId = crypto.randomUUID(); const payload = { providerId: 'test.acp', label: 'Stable identity', secret: 'recovery-test-secret-must-stay-server-side' };
  const original = await (await command(f, 'agents.storeCredential', payload, commandId)).json();
  const created = await (await command(f, 'agents.createProfile', { name: 'Stable agent', providerId: 'test.acp', parameters: {}, versionRequirement: '*', authentication: 'api-key', credentialRef: original.result.id })).json();
  const identity = f.bootstrap.access.identity; const port = Number(new URL(f.host.url).port); await f.host.close();
  const { maintainAccess } = await import('../apps/server/src/host.js'); await maintainAccess({ dataDir: f.options.dataDir, distributionDir: f.options.distributionDir, action: 'recover' });
  f.host = await startHost({ ...f.options, port }); cleanup.push(() => f.host.close());
  const exchange = await fetch(f.host.accessUrl!, { redirect: 'manual' }); f.session = exchange.headers.get('set-cookie')!.split(';')[0]!;
  f.bootstrap = await (await fetch(`${f.host.url}/api/bootstrap`, { headers: { Cookie: f.session } })).json(); expect(f.bootstrap.access.identity).toBe(identity);
  expect(await (await command(f, 'agents.storeCredential', payload, commandId)).json()).toEqual(original);
  const overview = await (await query(f)).json(); expect(overview.credentials).toHaveLength(1); expect(overview.profiles).toHaveLength(1); expect(overview.profiles[0].profile.id).toBe(created.result.id); expect(JSON.stringify(overview)).not.toContain(payload.secret);
});

test('broad permissions, wrong key length and symlink key files fail closed through the public credential settings', async () => {
  const f = await fixture(); const { chmod, rename, symlink } = await import('node:fs/promises'); const port = Number(new URL(f.host.url).port);
  await f.host.close(); await chmod(f.masterKeyFile, 0o644);
  for (const mode of ['broad', 'short', 'symlink']) {
    if (mode === 'short') { await chmod(f.masterKeyFile, 0o600); await writeFile(f.masterKeyFile, randomBytes(31)); }
    if (mode === 'symlink') { await rename(f.masterKeyFile, `${f.masterKeyFile}.target`); await writeFile(`${f.masterKeyFile}.target`, randomBytes(32)); await symlink(`${f.masterKeyFile}.target`, f.masterKeyFile); }
    f.host = await startHost({ ...f.options, port }); cleanup.push(() => f.host.close());
    expect((await (await query(f)).json()).credentialStorage.status).toBe('missing-key');
    const response = await command(f, 'agents.storeCredential', { providerId: 'test.acp', label: 'Rejected', secret: 'protection-check-secret' }); expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ error: { code: 'CREDENTIAL_KEY_UNAVAILABLE' } });
    expect((await (await query(f)).json()).credentials).toEqual([]); await f.host.close();
  }
});
