import { afterEach, expect, test } from 'vitest';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { startHost, maintainProfile } from '../apps/server/src/host.js';
import type { Bootstrap } from '@aork/sdk';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

/** A controlled stand-in for the pinned Codex adapter: same CLI surface
 * (own `name version` output, `cli login status` delegation for native state)
 * plus the ACP double. */
const adapterDouble = `import { writeFileSync, readFileSync, existsSync } from 'node:fs'; import { createHash } from 'node:crypto'; import { createInterface } from 'node:readline';
const argv = process.argv.slice(2);
if (argv.includes('--version')) { console.log('@agentclientprotocol/codex-acp 2.8.0'); process.exit(0); }
if (argv[0] === 'cli' && argv[1] === 'login' && argv[2] === 'status') {
  const home = process.env.CODEX_HOME;
  if (!home || !existsSync(home)) { process.stderr.write('Error loading configuration: CODEX_HOME does not exist\\n'); process.exit(2); }
  let loggedIn = false; try { loggedIn = JSON.parse(readFileSync(home + '/auth-state.json', 'utf8')).loggedIn === true; } catch {}
  process.stderr.write(loggedIn ? 'Logged in using ChatGPT\\n' : 'Not logged in\\n');
  process.exit(loggedIn ? 0 : 1);
}
const lines = createInterface({ input: process.stdin });
for await (const line of lines) { const request = JSON.parse(line); let result;
if (request.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: false, promptCapabilities: { image: true, audio: false, embeddedContext: true } }, agentInfo: { name: 'codex-acp', version: '2.8.0' }, authMethods: [{ id: 'api-key', name: 'API Key' }, { id: 'chat-gpt', name: 'ChatGPT' }] };
else if (request.method === 'session/new') { writeFileSync('codex-evidence.json', JSON.stringify({ environment: Object.keys(process.env).sort(), codexHome: process.env.CODEX_HOME ?? null, home: process.env.HOME ?? null, apiKeyDigest: process.env.OPENAI_API_KEY === undefined ? null : createHash('sha256').update(process.env.OPENAI_API_KEY).digest('hex'), codexApiKeyDigest: process.env.CODEX_API_KEY === undefined ? null : createHash('sha256').update(process.env.CODEX_API_KEY).digest('hex') })); result = { sessionId: 'native-codex-controlled' }; }
else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'unsupported' } }) + '\\n'); continue; }
process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n'); }
`;

interface CodexFixtureOptions { adapterSource?: string; adapterName?: string; configure?: boolean; adapterAbsent?: boolean }
async function codexFixture(options: CodexFixtureOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'aork-codex-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const distributionDir = join(directory, 'distribution'); await cp('dist', distributionDir, { recursive: true });
  const adapterEntry = join(directory, options.adapterName ?? 'codex-adapter.mjs');
  if (!options.adapterAbsent) await writeFile(adapterEntry, options.adapterSource ?? adapterDouble);
  const masterKeyFile = join(directory, 'master.key'); await writeFile(masterKeyFile, randomBytes(32), { mode: 0o600 });
  const profile = JSON.parse(await readFile('profiles/personal-server.json', 'utf8'));
  profile.plugins.push({ id: 'provider-codex', version: '0.1.0', enabled: true, ...(options.configure === false ? {} : { config: { nodeExecutable: process.execPath, adapterEntry } }) });
  profile.plugins.find((plugin: { id: string }) => plugin.id === 'agent-profiles').config = { masterKeyFile };
  const hostOptions = { dataDir: join(directory, 'data'), distributionDir, port: 0, insecureLoopback: true };
  await maintainProfile({ ...hostOptions, profile });
  let host = await startHost(hostOptions); cleanup.push(() => host.close());
  const exchange = await fetch(host.accessUrl!, { redirect: 'manual' }); const cookie = exchange.headers.get('set-cookie')!.split(';')[0]!;
  let bootstrap = await (await fetch(`${host.url}/api/bootstrap`, { headers: { Cookie: cookie } })).json() as Bootstrap;
  const command = (name: string, payload: unknown, commandId = crypto.randomUUID()) => fetch(`${host.url}/api/commands/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: host.url, Cookie: cookie, 'X-Aork-CSRF': bootstrap.access.csrfToken! }, body: JSON.stringify({ apiVersion: 1, commandVersion: 1, commandId, pluginGraphHash: bootstrap.pluginGraphHash, payload }) });
  const query = (name = 'agents.overview') => fetch(`${host.url}/api/queries/${name}`, { headers: { Cookie: cookie } });
  async function overview() { return await (await query('agents.overview')).json(); }
  async function researchWorkspace() {
    const created = await (await command('workspace.createProject', { name: 'Research', workspace: { name: 'Notes', management: 'managed' } })).json();
    return created.result;
  }
  async function readySession(profileId: string) {
    const { project, workspace } = await researchWorkspace();
    const session = (await (await command('sessions.create', { name: 'Codex conversation', projectId: project.id, workspaceId: workspace.id, profileId })).json()).result;
    expect((await command('sessions.startRun', { sessionId: session.id })).status).toBe(200);
    const deadline = Date.now() + 10000;
    for (;;) {
      const value = await (await query('sessions.overview')).json();
      const entry = value.sessions.find((candidate: { session: { id: string } }) => candidate.session.id === session.id);
      if (entry?.execution?.state === 'ready') return { session, workspace, execution: entry.execution };
      if (entry?.execution?.state === 'stopped' || entry?.execution?.state === 'unknown') throw new Error(`Run settled: ${JSON.stringify(entry.execution)}`);
      if (Date.now() > deadline) throw new Error('Run did not reach ready');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  return { directory, adapterEntry, hostOptions, masterKeyFile, get host() { return host; }, cookie, get bootstrap() { return bootstrap; }, command, query, overview, researchWorkspace, readySession };
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

test('the Codex Provider stays dormant without server toolchain configuration', async () => {
  const f = await codexFixture({ configure: false });
  expect(f.bootstrap.diagnostics).toEqual([]);
  expect((await f.overview()).providers.map((provider: { id: string }) => provider.id)).toEqual([]);
});

test('the Codex Provider detects the pinned adapter version and runs an API-key Profile end to end with isolated state', async () => {
  const f = await codexFixture();
  const overview = await f.overview();
  expect(overview.providers).toEqual([expect.objectContaining({ id: 'codex', detection: { status: 'available', version: '2.8.0' }, authentication: ['api-key', 'native-oauth'] })]);
  const secret = `codex-api-sentinel-${crypto.randomUUID()}`;
  const credential = (await (await f.command('agents.storeCredential', { providerId: 'codex', label: 'OpenAI key', secret })).json()).result;
  const profile = (await (await f.command('agents.createProfile', { name: 'Codex research', providerId: 'codex', parameters: {}, versionRequirement: '^2.8.0', authentication: 'api-key', credentialRef: credential.id })).json()).result;
  expect((await f.overview()).profiles[0]).toMatchObject({ availability: 'available', credentialStatus: 'ready' });
  const { workspace, execution } = await f.readySession(profile.id);
  const evidence = JSON.parse(await readFile(join(workspace.directory, 'codex-evidence.json'), 'utf8'));
  expect(evidence.environment).toEqual(['CODEX_HOME', 'HOME', 'LANG', 'OPENAI_API_KEY', 'PATH', ...(process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : [])]);
  expect(evidence.apiKeyDigest).toBe(createHash('sha256').update(secret).digest('hex'));
  expect(evidence.codexApiKeyDigest).toBeNull();
  expect(evidence.codexHome).toBe(profile.stateDirectory);
  expect(evidence.home).toBe(join(profile.stateDirectory, 'home'));
  expect(execution.detectedVersion).toBe('2.8.0');
  expect(execution.agentVersion).toBe('2.8.0');
  expect(execution.agentName).toBe('codex-acp');
  expect(await scanFor(f.hostOptions.dataDir, secret)).toEqual([]);
  await f.command('sessions.endRun', { runId: execution.runId });
});

test('native OAuth Profiles become available only after the isolated CODEX_HOME reports a local login', async () => {
  const f = await codexFixture();
  const profile = (await (await f.command('agents.createProfile', { name: 'Codex subscription', providerId: 'codex', parameters: {}, versionRequirement: '^2.8.0', authentication: 'native-oauth' })).json()).result;
  let overview = await f.overview();
  expect(overview.profiles[0]).toMatchObject({ availability: 'unavailable', reason: 'native-authentication-required', credentialStatus: 'native-directory-only' });
  await writeFile(join(profile.stateDirectory, 'auth-state.json'), JSON.stringify({ loggedIn: true }));
  overview = await f.overview();
  expect(overview.profiles[0]).toMatchObject({ availability: 'available', credentialStatus: 'native-login-metadata' });
  const { workspace, execution } = await f.readySession(profile.id);
  const evidence = JSON.parse(await readFile(join(workspace.directory, 'codex-evidence.json'), 'utf8'));
  expect(evidence.apiKeyDigest).toBeNull();
  expect(evidence.codexHome).toBe(profile.stateDirectory);
  expect(evidence.home).toBe(join(profile.stateDirectory, 'home'));
  expect(evidence.environment).not.toContain('OPENAI_API_KEY');
  await f.command('sessions.endRun', { runId: execution.runId });
});

test('missing, foreign or malformed adapter outputs fail detection closed with a bounded reason', async () => {
  const missing = await codexFixture({ adapterAbsent: true });
  expect((await missing.overview()).providers[0]).toMatchObject({ id: 'codex', detection: { status: 'unavailable', reason: 'binary-missing' } });
  const rejected = await missing.command('agents.createProfile', { name: 'Unavailable', providerId: 'codex', parameters: {}, versionRequirement: '^2.8.0', authentication: 'native-oauth' });
  expect(rejected.status).toBe(200);
  // A bare version without the pinned adapter identity is some other tool.
  const foreign = await codexFixture({ adapterSource: `if (process.argv.includes('--version')) { console.log('2.8.0'); process.exit(0); } process.exit(2);` });
  expect((await foreign.overview()).providers[0]).toMatchObject({ id: 'codex', detection: { status: 'unavailable', reason: 'provider-failed' } });
  const malformed = await codexFixture({ adapterSource: `if (process.argv.includes('--version')) { console.log('@agentclientprotocol/codex-acp not-a-version'); process.exit(0); } process.exit(2);` });
  expect((await malformed.overview()).providers[0]).toMatchObject({ id: 'codex', detection: { status: 'unavailable', reason: 'provider-failed' } });
  const hanging = await codexFixture({ adapterSource: `if (process.argv.includes('--version')) { setInterval(() => {}, 60000); } else { process.exit(2); }` });
  expect((await hanging.overview()).providers[0]).toMatchObject({ id: 'codex', detection: { status: 'unavailable', reason: 'provider-failed' } });
// Four full-profile fixture boots; the default profile grew with the tools plugins.
}, 30000);
