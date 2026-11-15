import { afterEach, expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { startHost } from '../apps/server/src/host.js';
const execute = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const cli = (...args: string[]) => execute(process.execPath, ['dist/server/main.mjs', ...args]);
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'aork-compat-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const profile = JSON.parse(await readFile('profiles/personal-server.json', 'utf8'));
  return { directory, dataDir: join(directory, 'data'), profile, archive: join(directory, 'plugin.aork-plugin'), profileFile: join(directory, 'profile.json') };
}
async function archive(path: string, patch: Record<string, unknown> = {}, source = 'export function activate() {}') {
  const manifest = { manifestVersion: 1, id: 'independent', version: '1.0.0', sdkRange: '~0.1.0', server: 'server.js', requires: [], provides: [], capabilities: [], ui: { providers: [] }, ...patch };
  const files = [['aork.plugin.json', JSON.stringify(manifest)], ['server.js', source]];
  await writeFile(path, JSON.stringify({ archiveVersion: 1, members: files.map(([path, content]) => { const bytes = Buffer.from(content!); return { path, type: 'file', data: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') }; }) }));
}
async function install(f: Awaited<ReturnType<typeof fixture>>) { await writeFile(f.profileFile, JSON.stringify(f.profile)); return cli('plugin', 'install', f.archive, '--profile', f.profileFile, '--data-dir', f.dataDir); }

test('invalid private configuration is rejected with package and fix, preserves valid graph, and the corrected archive installs before first start', async () => {
  const f = await fixture(); const marker = join(f.directory, 'executed');
  await archive(f.archive, { configSchema: { type: 'object', properties: { credential: { type: 'string', minLength: 20 } }, required: ['credential'], additionalProperties: false } }, `import { writeFileSync } from 'node:fs';writeFileSync(${JSON.stringify(marker)},'executed');export function activate(context) {context.query('independent.config',{access:'authenticated',execute:()=>({configured:context.config.credential.length===24})});}`);
  f.profile.plugins.push({ id: 'independent', version: '1.0.0', enabled: true, config: { credential: 'private-bad-secret' } });
  const failure = await install(f).catch(error => error);
  expect(failure.stderr).toContain('CONFIG_INVALID'); expect(failure.stderr).toContain('independent@1.0.0'); expect(failure.stderr).toContain('Correct'); expect(failure.stderr).not.toContain('private-bad-secret');
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  f.profile.plugins.at(-1).config.credential = 'private-good-secret-1234';
  await install(f);
  const host = await startHost({ dataDir: f.dataDir, port: 0, insecureLoopback: true }); cleanup.push(() => host.close());
  const response = await fetch(host.accessUrl!, { redirect: 'manual' }); const Cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  expect(await (await fetch(`${host.url}/api/queries/independent.config`, { headers: { Cookie } })).json()).toEqual({ configured: true });
  expect(JSON.stringify(await (await fetch(`${host.url}/api/bootstrap`, { headers: { Cookie } })).json())).not.toContain('private-good-secret');
});

test('mandatory plugin dependencies fail precisely; absent optional dependencies allow activation and present incompatible optional dependencies fail', async () => {
  const f = await fixture(); f.profile.plugins.push({ id: 'independent', version: '1.0.0', enabled: true });
  await archive(f.archive, { dependencies: [{ id: 'missing', range: '^1.0.0' }] });
  expect((await install(f).catch(error => error)).stderr).toContain('PLUGIN_DEPENDENCY_MISSING');
  await archive(f.archive, { dependencies: [{ id: 'workbench', range: '^9.0.0', optional: true }] });
  expect((await install(f).catch(error => error)).stderr).toContain('PLUGIN_DEPENDENCY_INCOMPATIBLE');
  await archive(f.archive, { dependencies: [{ id: 'missing', range: '^1.0.0', optional: true }] });
  await install(f);
  const host = await startHost({ dataDir: f.dataDir, port: 0 }); cleanup.push(() => host.close());
  expect((await (await fetch(`${host.url}/api/bootstrap`)).json()).diagnostics).toEqual([]);
});

test('a declared capability is refused until explicitly granted; unsupported capabilities never activate', async () => {
  const f = await fixture(); f.profile.plugins.push({ id: 'independent', version: '1.0.0', enabled: true });
  await archive(f.archive, { capabilities: ['diagnostics.read'] });
  expect((await install(f).catch(error => error)).stderr).toContain('CAPABILITY_NOT_GRANTED');
  f.profile.plugins.at(-1).grants = ['diagnostics.read']; await install(f);
  const host = await startHost({ dataDir: f.dataDir, port: 0 }); cleanup.push(() => host.close());
  expect((await (await fetch(`${host.url}/api/bootstrap`)).json()).diagnostics).toEqual([]);
});

test('multi-provider services require a named selection and resolve that provider without overwriting another registration', async () => {
  const f = await fixture();
  const first = join(f.directory, 'first.aork-plugin'); const second = join(f.directory, 'second.aork-plugin');
  await archive(first, { id: 'first', provides: ['demo.renderer@1'], serviceModes: { 'demo.renderer@1': 'multi-provider' } }, "export function activate(c) {c.provide('demo.renderer@1',{name:'first'});}");
  await cli('plugin', 'install', first, '--data-dir', f.dataDir);
  await archive(second, { id: 'second', provides: ['demo.renderer@1'], serviceModes: { 'demo.renderer@1': 'multi-provider' } }, "export function activate(c) {c.provide('demo.renderer@1',{name:'second'});}");
  await cli('plugin', 'install', second, '--data-dir', f.dataDir);
  f.profile.plugins.push(...['first', 'second', 'independent'].map(id => ({ id, version: '1.0.0', enabled: true })));
  await archive(f.archive, { requires: ['demo.renderer@1'] }, "export function activate(c) {c.query('independent.provider',{access:'authenticated',execute:()=>c.service('demo.renderer@1')});}");
  expect((await install(f).catch(error => error)).stderr).toContain('SERVICE_SELECTION_REQUIRED');
  f.profile.services = { 'demo.renderer@1': 'second' }; await install(f);
  const host = await startHost({ dataDir: f.dataDir, port: 0, insecureLoopback: true }); cleanup.push(() => host.close());
  const login = await fetch(host.accessUrl!, { redirect: 'manual' }); const Cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  expect(await (await fetch(`${host.url}/api/queries/independent.provider`, { headers: { Cookie } })).json()).toEqual({ name: 'second' });
});

test('archive UI contracts, runtime and extension metadata and explicit fallbacks fail preflight with actionable identifiers', async () => {
  const f = await fixture();
  await archive(f.archive, { ui: { providers: [], runtime: { react: '^99.0.0', sdk: '~0.1.0' } } });
  expect((await install(f).catch(error => error)).stderr).toContain('UI_RUNTIME_INCOMPATIBLE');
  await archive(f.archive);
  f.profile.ui.fallbacks = { 'aork.workbench.home@1': 'workbench:absent' };
  expect((await install(f).catch(error => error)).stderr).toContain('UI_FALLBACK_UNAVAILABLE');
  f.profile.ui.fallbacks = { 'aork.workbench.home@1': 'workbench:home' }; await install(f);
});

test('a rejected candidate is visible through authenticated plugin diagnostics while the unchanged valid profile still starts', async () => {
  const f = await fixture();
  await archive(f.archive, { ui: { providers: [{ id: 'bad', contract: 'aork.workbench.home@99' }] } });
  expect((await install(f).catch(error => error)).stderr).toContain('UI_CONTRACT_INCOMPATIBLE');
  const host = await startHost({ dataDir: f.dataDir, port: 0, insecureLoopback: true }); cleanup.push(() => host.close());
  expect((await fetch(`${host.url}/api/queries/plugins.diagnostics`)).status).toBe(401);
  const login = await fetch(host.accessUrl!, { redirect: 'manual' }); const Cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const response = await fetch(`${host.url}/api/queries/plugins.diagnostics`, { headers: { Cookie } }); expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ rejected: { code: 'UI_CONTRACT_INCOMPATIBLE', pluginId: 'independent', version: '1.0.0', remedy: expect.any(String) } });
});

for (const [name, patch, code] of [
  ['invalid exact plugin version', { version: '1.x' }, 'PLUGIN_VERSION_INVALID'],
  ['invalid SDK range', { sdkRange: 'wrong' }, 'SDK_INCOMPATIBLE'],
  ['invalid dependency range', { dependencies: [{ id: 'workbench', range: 'wrong' }] }, 'PLUGIN_DEPENDENCY_RANGE_INVALID'],
  ['malformed schema', { configSchema: { type: 'object', unknownKeyword: true } }, 'CONFIG_SCHEMA_INVALID'],
  ['missing service contract', { requires: ['demo.absent@1'] }, 'SERVICE_MISSING'],
  ['conflicting singleton', { provides: ['aork.workbench@1'] }, 'SERVICE_CONFLICT'],
  ['unknown capability', { capabilities: ['native.process'] }, 'CAPABILITY_UNAVAILABLE'],
  ['unknown UI major', { client: 'client.js', ui: { providers: [{ id: 'home', contract: 'aork.workbench.home@99' }] } }, 'UI_CONTRACT_INCOMPATIBLE'],
  ['duplicate UI providers', { client: 'client.js', ui: { providers: [{ id: 'home', contract: 'aork.workbench.home@1' }, { id: 'home', contract: 'aork.workbench.home@1' }] } }, 'UI_PROVIDER_DUPLICATE'],
  ['unknown extension target', { client: 'client.js', ui: { extensions: [{ id: 'header', target: 'aork.workbench.header@99' }] } }, 'UI_EXTENSION_TARGET_UNAVAILABLE'],
  ['duplicate extensions', { client: 'client.js', ui: { extensions: [{ id: 'header', target: 'aork.workbench.header@1' }, { id: 'header', target: 'aork.workbench.header@1' }] } }, 'UI_EXTENSION_DUPLICATE'],
  ['missing UI service', { client: 'client.js', ui: { providers: [{ id: 'home', contract: 'aork.workbench.home@1', requires: ['demo.absent@1'] }] } }, 'SERVICE_MISSING'],
  ['undeclared UI capability', { client: 'client.js', ui: { providers: [{ id: 'home', contract: 'aork.workbench.home@1', capabilities: ['diagnostics.read'] }] } }, 'UI_CAPABILITY_UNDECLARED'],
] as const) test(`initial installation rejects ${name} before entry execution and retains the prior profile`, async () => {
  const f = await fixture(); await archive(f.archive); const initial = await install(f);
  // Establish a valid candidate/profile on the still-fresh instance before proposing the malformed package.
  const previous = JSON.parse(initial.stdout).profile;
  const malformed = join(f.directory, 'bad.aork-plugin'); const marker = join(f.directory, 'activated');
  await archive(malformed, { id: 'bad-candidate', ...patch }, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'activated');export function activate(){}`);
  // UI code is an explicitly declared independent archive member.
  if ('client' in patch) {
    const input = JSON.parse(await readFile(malformed, 'utf8')); const bytes = Buffer.from('export function activate(){}'); input.members.push({ path:'client.js',type:'file',data:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex') }); await writeFile(malformed,JSON.stringify(input));
  }
  f.profile.plugins.push({ id: 'bad-candidate', version: '1.0.0', enabled: true }); await writeFile(f.profileFile, JSON.stringify(f.profile));
  const failure = await cli('plugin','install',malformed,'--data-dir',f.dataDir,'--profile',f.profileFile).catch(error => error);
  expect(failure.stderr).toContain(code); await expect(readFile(marker)).rejects.toMatchObject({ code:'ENOENT' });
  expect(JSON.parse((await cli('doctor','--data-dir',f.dataDir)).stdout).profile).toEqual(previous);
});

test('a dependency cycle and incompatible contract major are rejected without importing candidates', async () => {
  const f = await fixture(); const first = join(f.directory,'first.aork-plugin');
  await archive(first,{id:'first',dependencies:[{id:'independent',range:'^1.0.0',optional:true}],provides:['demo.service@2']}); await cli('plugin','install',first,'--data-dir',f.dataDir);
  f.profile.plugins.push({id:'first',version:'1.0.0',enabled:true},{id:'independent',version:'1.0.0',enabled:true});
  await archive(f.archive,{dependencies:[{id:'first',range:'^1.0.0'}]}); expect((await install(f).catch(error=>error)).stderr).toContain('DEPENDENCY_CYCLE');
  await archive(f.archive,{requires:['demo.service@1']}); expect((await install(f).catch(error=>error)).stderr).toContain('SERVICE_CONTRACT_INCOMPATIBLE');
});
