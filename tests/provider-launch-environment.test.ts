import { afterEach, expect, test } from 'vitest';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { startHost, maintainProfile } from '../apps/server/src/host.js';
import type { Bootstrap } from '@aork/sdk';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

/** A controlled ACP double that records the exact environment it was launched with.
 * Secret values are never written out; only their digest proves delivery. */
const agent = `import { writeFileSync } from 'node:fs'; import { createHash } from 'node:crypto'; import { createInterface } from 'node:readline';
if (process.argv[2] === '--version') { console.log('1.2.0'); process.exit(0); }
const lines = createInterface({ input: process.stdin });
for await (const line of lines) { const request = JSON.parse(line); let result;
if (request.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: false }, agentInfo: { name: 'controlled-launch', version: '1.2.0' }, authMethods: [] };
else if (request.method === 'session/new') { writeFileSync('launch-evidence.json', JSON.stringify({ cwd: process.cwd(), environment: Object.keys(process.env).sort(), home: process.env.HOME ?? null, configDir: process.env.CLAUDE_CONFIG_DIR ?? null, protocol: process.env.CLAUDE_AGENT_ACP_PROTOCOL ?? null, apiKeyDigest: process.env.ANTHROPIC_API_KEY === undefined ? null : createHash('sha256').update(process.env.ANTHROPIC_API_KEY).digest('hex') })); result = { sessionId: 'native-launch-controlled' }; }
else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'unsupported' } }) + '\\n'); continue; }
process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n'); }
`;

interface FixtureOptions { planName?: string }
async function launchFixture(options: FixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'aork-launch-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const distributionDir = join(directory, 'distribution'); await cp('dist', distributionDir, { recursive: true });
  const executable = join(directory, 'controlled-agent.mjs'); await writeFile(executable, agent);
  const fixedName = options.planName ?? 'CLAUDE_AGENT_ACP_PROTOCOL';
  const provider = join(distributionDir, 'plugins/launch-test-agent/0.1.0'); await mkdir(provider, { recursive: true });
  await writeFile(join(provider, 'aork.plugin.json'), JSON.stringify({ manifestVersion: 1, id: 'launch-test-agent', version: '0.1.0', sdkRange: '^0.1.0', server: 'server.js', requires: ['aork.agent.providers@1'], ui: { providers: [] } }));
  await writeFile(join(provider, 'server.js'), `import { execFileSync } from 'node:child_process'; import { existsSync } from 'node:fs'; export function activate(context) {
    const registry = context.service('aork.agent.providers@1');
    const common = { version: '1.2.0', parameters: [], parseParameters(value) { if (Object.keys(value).length) throw new Error('invalid parameters'); return value; }, launch: { executable: process.execPath, arguments: [${JSON.stringify(executable)}], protocol: 'acp-stdio' }, detect() { return { status: 'available', version: execFileSync(process.execPath, [${JSON.stringify(executable)}, '--version'], { encoding: 'utf8', timeout: 1000 }).trim() }; } };
    const disposeAuth = registry.register({ ...common, id: 'launch.auth', label: 'Launch Auth Agent', authentication: ['none', 'api-key', 'native-oauth'],
      launchEnvironment: { 'api-key': { fixed: { ${JSON.stringify(fixedName)}: 'v1' }, stateDirectoryNames: ['CLAUDE_CONFIG_DIR'], homeChildDirectory: 'home', credentialName: 'ANTHROPIC_API_KEY' }, 'native-oauth': { fixed: { ${JSON.stringify(fixedName)}: 'v1' }, stateDirectoryNames: ['CLAUDE_CONFIG_DIR'], homeChildDirectory: 'home' } },
      observeNativeLogin(input) { return existsSync(input.stateDirectory + '/login-metadata.json') ? 'observed' : 'absent'; } }, context.owner);
    const disposePlain = registry.register({ ...common, id: 'launch.plain', label: 'Plain Agent', authentication: ['none', 'api-key'] }, context.owner);
    context.effect(() => () => { disposeAuth(); disposePlain(); });
  }`);
  const foreign = join(distributionDir, 'plugins/launch-foreign/0.1.0'); await mkdir(foreign, { recursive: true });
  await writeFile(join(foreign, 'aork.plugin.json'), JSON.stringify({ manifestVersion: 1, id: 'launch-foreign', version: '0.1.0', sdkRange: '^0.1.0', server: 'server.js', requires: ['aork.agent.launch-environment@1'], ui: { providers: [] } }));
  await writeFile(join(foreign, 'server.js'), `export function activate(context) {
    context.query('test.foreignGrant', { access: 'authenticated', execute() {
      const service = context.service('aork.agent.launch-environment@1');
      const codes = {};
      try { service.bind({ profile: {}, launch: {} }, { runId: crypto.randomUUID(), generation: 1, hostEpoch: context.owner.hostEpoch }); codes.bind = 'ok'; } catch (error) { codes.bind = error.code ?? 'thrown'; }
      try { service.consume(Object.freeze({ environmentNames: [] }), () => {}); codes.consume = 'ok'; } catch (error) { codes.consume = error.code ?? 'thrown'; }
      return codes;
    } });
  }`);
  const masterKeyFile = join(directory, 'master.key'); await writeFile(masterKeyFile, randomBytes(32), { mode: 0o600 });
  const profile = JSON.parse(await readFile('profiles/personal-server.json', 'utf8'));
  profile.plugins.push({ id: 'launch-test-agent', version: '0.1.0', enabled: true }, { id: 'launch-foreign', version: '0.1.0', enabled: true });
  profile.plugins.find((plugin: { id: string }) => plugin.id === 'agent-profiles').config = { masterKeyFile };
  const options_ = { dataDir: join(directory, 'data'), distributionDir, port: 0, insecureLoopback: true };
  await maintainProfile({ ...options_, profile });
  let host = await startHost(options_); cleanup.push(() => host.close());
  // A failed plugin activation leaves the graph degraded (no access URL); the
  // public surface for those fixtures is the unauthenticated bootstrap only.
  let cookie = '';
  if (host.accessUrl) { const exchange = await fetch(host.accessUrl, { redirect: 'manual' }); cookie = exchange.headers.get('set-cookie')!.split(';')[0]!; }
  let bootstrap = await (await fetch(`${host.url}/api/bootstrap`, { headers: { Cookie: cookie } })).json() as Bootstrap;
  async function refresh() { bootstrap = await (await fetch(`${host.url}/api/bootstrap`, { headers: { Cookie: cookie } })).json() as Bootstrap; }
  const command = (name: string, payload: unknown, commandId = crypto.randomUUID()) => fetch(`${host.url}/api/commands/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: host.url, Cookie: cookie, 'X-Aork-CSRF': bootstrap.access.csrfToken! }, body: JSON.stringify({ apiVersion: 1, commandVersion: 1, commandId, pluginGraphHash: bootstrap.pluginGraphHash, payload }) });
  const query = (name = 'agents.overview') => fetch(`${host.url}/api/queries/${name}`, { headers: { Cookie: cookie } });
  async function overview() { return await (await query('agents.overview')).json(); }
  async function workspace() {
    const workspaceDirectory = join(directory, `workspace-${crypto.randomUUID()}`); await mkdir(workspaceDirectory, { recursive: true });
    const created = await (await command('workspace.create', { workspace: { name: 'Notes', directory: workspaceDirectory, access: 'read-write' } })).json();
    return created.result;
  }
  async function makeProfile(providerId: string, authentication: 'none' | 'api-key' | 'native-oauth', credentialRef: string | null = null, versionRequirement = '^1.0.0') {
    const response = await command('agents.createProfile', { name: `Profile ${authentication}`, providerId, parameters: {}, versionRequirement, authentication, credentialRef });
    expect(response.status).toBe(200);
    return (await response.json()).result;
  }
  async function startRun(sessionId: string) { return command('sessions.startRun', { sessionId }); }
  async function createSession(workspaceId: string, profileId: string) { return (await (await command('sessions.create', { name: 'Research conversation', workspaceId, profileId })).json()).result; }
  async function runState(sessionId: string, state: string) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const value = await (await query('sessions.overview')).json();
      const entry = value.sessions?.find((candidate: { session: { id: string } }) => candidate.session.id === sessionId);
      if (entry?.execution?.state === state) return entry.execution;
      const rejected = entry?.execution?.state === 'unknown' || entry?.execution?.state === 'stopped';
      if (rejected && state !== 'stopped' && state !== 'unknown') throw new Error(`Run settled early: ${JSON.stringify(entry.execution)}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`Run did not reach ${state}`);
  }
  return { directory, options: options_, masterKeyFile, get host() { return host; }, cookie, get bootstrap() { return bootstrap; }, refresh, command, query, overview, workspace, makeProfile, createSession, startRun, runState,
    async restart() { const port = Number(new URL(host.url).port); await host.close(); host = await startHost({ ...options_, port }); await refresh(); } };
}

async function scanFor(directory: string, needle: string): Promise<string[]> {
  const hits: string[] = [];
  async function walk(current: string) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if ((await readFile(path)).includes(Buffer.from(needle))) hits.push(path);
    }
  }
  await walk(directory);
  return hits;
}

test('API-key Profile injects its credential only into the managed child environment and records names, never values', async () => {
  const f = await launchFixture();
  const secret = `anthropic-sentinel-${crypto.randomUUID()}`;
  const credential = (await (await f.command('agents.storeCredential', { providerId: 'launch.auth', label: 'Research key', secret })).json()).result;
  const profile = await f.makeProfile('launch.auth', 'api-key', credential.id);
  const workspace = await f.workspace();
  const session = await f.createSession(workspace.id, profile.id);
  expect((await f.startRun(session.id)).status).toBe(200);
  const execution = await f.runState(session.id, 'ready');
  const evidence = JSON.parse(await readFile(join(workspace.directory, 'launch-evidence.json'), 'utf8'));
  const expectedNames = ['ANTHROPIC_API_KEY', 'CLAUDE_AGENT_ACP_PROTOCOL', 'CLAUDE_CONFIG_DIR', 'HOME', 'LANG', 'PATH', ...(process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : [])];
  expect(evidence.environment).toEqual(expectedNames);
  expect(evidence.apiKeyDigest).toBe(createHash('sha256').update(secret).digest('hex'));
  expect(evidence.configDir).toBe(profile.stateDirectory);
  expect(evidence.home).toBe(join(profile.stateDirectory, 'home'));
  expect(evidence.protocol).toBe('v1');
  expect((await stat(join(profile.stateDirectory, 'home'))).mode & 0o077).toBe(0);
  expect(execution.environment).toEqual({ inherited: false, names: expectedNames });
  expect(execution.agentVersion).toBe('1.2.0');
  await f.command('sessions.endRun', { runId: execution.runId });
  await f.runState(session.id, 'stopped');
  for (const surface of [JSON.stringify(await f.overview()), JSON.stringify(f.bootstrap)]) expect(surface).not.toContain(secret);
  const events = await (await fetch(`${f.host.url}/api/events?after=0&limit=200`, { headers: { Cookie: f.cookie } })).text();
  expect(events).not.toContain(secret);
  expect(await scanFor(f.options.dataDir, secret)).toEqual([]);
});

test('native OAuth Profiles distinguish observed local login metadata from a merely protected directory', async () => {
  const f = await launchFixture();
  const profile = await f.makeProfile('launch.auth', 'native-oauth');
  const before = (await f.overview()).profiles.find((row: { profile: { id: string } }) => row.profile.id === profile.id);
  expect(before).toMatchObject({ availability: 'unavailable', reason: 'native-authentication-required', credentialStatus: 'native-directory-only' });
  await writeFile(join(profile.stateDirectory, 'login-metadata.json'), '{}');
  const after = (await f.overview()).profiles.find((row: { profile: { id: string } }) => row.profile.id === profile.id);
  expect(after).toMatchObject({ availability: 'available', credentialStatus: 'native-login-metadata' });
  const workspace = await f.workspace();
  const session = await f.createSession(workspace.id, profile.id);
  expect((await f.startRun(session.id)).status).toBe(200);
  const execution = await f.runState(session.id, 'ready');
  const evidence = JSON.parse(await readFile(join(workspace.directory, 'launch-evidence.json'), 'utf8'));
  expect(evidence.environment).toEqual(['CLAUDE_AGENT_ACP_PROTOCOL', 'CLAUDE_CONFIG_DIR', 'HOME', 'LANG', 'PATH', ...(process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : [])]);
  expect(evidence.apiKeyDigest).toBeNull();
  expect(evidence.configDir).toBe(profile.stateDirectory);
  await f.command('sessions.endRun', { runId: execution.runId });
  await f.runState(session.id, 'stopped');
});

test('Providers without a declared launch environment keep authenticated Profiles unlaunchable and none Profiles unchanged', async () => {
  const f = await launchFixture();
  const secret = `plain-sentinel-${crypto.randomUUID()}`;
  const credential = (await (await f.command('agents.storeCredential', { providerId: 'launch.plain', label: 'Plain key', secret })).json()).result;
  const plain = await f.makeProfile('launch.plain', 'api-key', credential.id);
  const workspace = await f.workspace();
  const session = await f.createSession(workspace.id, plain.id);
  const rejected = await f.startRun(session.id);
  expect(rejected.status).toBe(409); expect(await rejected.json()).toMatchObject({ error: { code: 'PROVIDER_LAUNCH_AUTH_UNSUPPORTED' } });
  const baseline = await f.makeProfile('launch.plain', 'none');
  const plainSession = await f.createSession(workspace.id, baseline.id);
  expect((await f.startRun(plainSession.id)).status).toBe(200);
  const execution = await f.runState(plainSession.id, 'ready');
  const evidence = JSON.parse(await readFile(join(workspace.directory, 'launch-evidence.json'), 'utf8'));
  expect(evidence.environment).toEqual(process.platform === 'darwin' ? ['LANG', 'PATH', '__CF_USER_TEXT_ENCODING'] : ['LANG', 'PATH']);
  await f.command('sessions.endRun', { runId: execution.runId });
  await f.runState(plainSession.id, 'stopped');
});

test('launch environment grants are bound to the selected Runtime owner and cannot be forged or reused by other plugins', async () => {
  const f = await launchFixture();
  const attempt = await (await (await f.query('test.foreignGrant')).json());
  // The foreign plugin never passes the Runtime-owner check on either path,
  // regardless of the snapshot or grant objects it presents.
  expect(attempt).toEqual({ bind: 'LAUNCH_ENVIRONMENT_OWNER_INVALID', consume: 'LAUNCH_ENVIRONMENT_OWNER_INVALID' });
});

test('an unreadable credential fails the Run visibly and never starts a process', async () => {
  const f = await launchFixture();
  const secret = `rotating-sentinel-${crypto.randomUUID()}`;
  const credential = (await (await f.command('agents.storeCredential', { providerId: 'launch.auth', label: 'Rotating key', secret })).json()).result;
  const profile = await f.makeProfile('launch.auth', 'api-key', credential.id);
  await writeFile(f.masterKeyFile, randomBytes(32), { mode: 0o600 });
  await f.restart();
  const workspace = await f.workspace();
  const session = await f.createSession(workspace.id, profile.id);
  const rejected = await f.startRun(session.id);
  expect(rejected.status).toBeGreaterThanOrEqual(400);
  expect((await rejected.json()).error?.code).toBe('CREDENTIAL_UNREADABLE');
  const value = await (await f.query('sessions.overview')).json();
  const entry = value.sessions.find((candidate: { session: { id: string } }) => candidate.session.id === session.id);
  expect(entry.execution).toMatchObject({ state: 'not-started' });
});

test('launch environment plans with names outside the fixed Provider allowlist fail activation closed', async () => {
  const f = await launchFixture({ planName: 'ARBITRARY_INJECTED_NAME' });
  expect(f.bootstrap.diagnostics).toEqual([expect.objectContaining({ code: 'PLUGIN_ACTIVATION_FAILED', pluginId: 'launch-test-agent' })]);
});
