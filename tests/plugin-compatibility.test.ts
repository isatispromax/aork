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

test('the independent builder refuses private Host imports before producing an archive', async () => {
  const f = await fixture(); const source = join(f.directory,'source');
  const { mkdir } = await import('node:fs/promises'); await mkdir(join(source,'src'),{recursive:true});
  await writeFile(join(source,'aork.plugin.json'), JSON.stringify({manifestVersion:1,id:'boundary-check',version:'1.0.0',sdkRange:'~0.1.0',server:'server.js',ui:{providers:[]}}));
  const privateSource=join(process.cwd(),'plugins/workbench/src/server.ts');
  await writeFile(join(source,'src/server.ts'),`export {activate} from ${JSON.stringify(privateSource)};`);
  const failure=await execute(process.execPath,['scripts/plugin-build.mjs','--dir',source,'--out',f.archive]).catch(error=>error);
  expect(failure.stderr).toContain('PLUGIN_PRIVATE_IMPORT'); await expect(readFile(f.archive)).rejects.toMatchObject({code:'ENOENT'});
});

test('data-derived config keys remain absent from CLI and authenticated rejected-package diagnostics', async () => {
  const f=await fixture();f.profile.plugins.push({id:'independent',version:'1.0.0',enabled:true,config:{'private-key-token-123':'wrong'}});
  await archive(f.archive,{configSchema:{type:'object',additionalProperties:{type:'number'}}});
  const failure=await install(f).catch(error=>error);expect(failure.stderr).toContain('CONFIG_INVALID');expect(failure.stderr).not.toContain('private-key-token-123');
  const host=await startHost({dataDir:f.dataDir,port:0,insecureLoopback:true});cleanup.push(()=>host.close());const login=await fetch(host.accessUrl!,{redirect:'manual'});const Cookie=login.headers.get('set-cookie')!.split(';')[0]!;
  const report=await(await fetch(`${host.url}/api/queries/plugins.diagnostics`,{headers:{Cookie}})).text();expect(report).not.toContain('private-key-token-123');expect(report).toContain('CONFIG_INVALID');
});

test('Host-owned service IDs cannot be claimed to bypass a required capability grant',async()=>{
  const f=await fixture();f.profile.plugins.push({id:'independent',version:'1.0.0',enabled:true});await archive(f.archive,{provides:['aork.plugins.diagnostics@1']},"export function activate(c){const diagnostics=c.service('aork.plugins.diagnostics@1');c.provide('aork.plugins.diagnostics@1',{});c.query('independent.leak',{access:'public',execute:()=>diagnostics.inspect()});}");
  expect((await install(f).catch(error=>error)).stderr).toContain('SERVICE_RESERVED');
});

test('unsupported capabilities are rejected even for an unselected candidate',async()=>{
  const f=await fixture();await archive(f.archive,{capabilities:['unavailable.host-power']});
  expect((await cli('plugin','install',f.archive,'--data-dir',f.dataDir).catch(error=>error)).stderr).toContain('CAPABILITY_UNAVAILABLE');
});

test('enabled multi-provider contracts always need explicit selection even when the Host is the only consumer',async()=>{
  const f=await fixture();const first=join(f.directory,'first.aork-plugin');await archive(first,{id:'first',provides:['demo.host-consumer@1'],serviceModes:{'demo.host-consumer@1':'multi-provider'}});await cli('plugin','install',first,'--data-dir',f.dataDir);
  f.profile.plugins.push({id:'first',version:'1.0.0',enabled:true},{id:'independent',version:'1.0.0',enabled:true});await archive(f.archive,{provides:['demo.host-consumer@1'],serviceModes:{'demo.host-consumer@1':'multi-provider'}});
  expect((await install(f).catch(error=>error)).stderr).toContain('SERVICE_SELECTION_REQUIRED');
});

test('malformed private profile JSON is reported without echoing its input into CLI output',async()=>{
  const f=await fixture();await archive(f.archive);await writeFile(f.profileFile,'private-profile-token-123');
  const failure=await cli('plugin','install',f.archive,'--data-dir',f.dataDir,'--profile',f.profileFile).catch(error=>error);
  expect(failure.stderr).not.toContain('private-pr');expect(failure.stderr).toContain('METADATA_INVALID');
});

test('async configuration schemas are rejected before validation without an unhandled error or private key leak, and a corrected archive can install', async () => {
  const f = await fixture(); await archive(f.archive); const original = JSON.parse((await install(f)).stdout).profile;
  const malformed = join(f.directory, 'async.aork-plugin'); const marker = join(f.directory, 'async-entry-imported');
  f.profile.plugins.push({ id: 'async-config', version: '1.0.0', enabled: true, config: { 'private-async-key-05': 'invalid' } });
  await archive(malformed, { id: 'async-config', configSchema: { $async: true, type: 'object', additionalProperties: { type: 'number' } } }, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'imported');export function activate(){}`);
  await writeFile(f.profileFile, JSON.stringify(f.profile));
  const failure = await cli('plugin', 'install', malformed, '--data-dir', f.dataDir, '--profile', f.profileFile).catch(error => error);
  expect(failure.stderr).toContain('CONFIG_SCHEMA_INVALID'); expect(failure.stderr).not.toContain('ValidationError'); expect(failure.stderr).not.toContain('private-async-key-05');
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  await archive(malformed, { id: 'async-config', configSchema: { type: 'object', additionalProperties: { type: 'string' } } });
  expect(JSON.parse((await cli('plugin', 'install', malformed, '--data-dir', f.dataDir, '--profile', f.profileFile)).stdout).installed.id).toBe('async-config');
  const host = await startHost({ dataDir: f.dataDir, port: 0, insecureLoopback: true }); cleanup.push(() => host.close());
  const login = await fetch(host.accessUrl!, { redirect: 'manual' }); const Cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const report = await (await fetch(`${host.url}/api/queries/plugins.diagnostics`, { headers: { Cookie } })).json();
  expect(report.rejected.code).toBe('CONFIG_SCHEMA_INVALID'); expect(JSON.stringify(report)).not.toContain('private-async-key-05');
  expect(report.profile.plugins.filter((plugin: {id:string}) => plugin.id !== 'async-config')).toEqual(original.plugins);
});

test('access rotation targets the explicitly selected authorization owner and recovery restores the default binding and compatible owner set', async () => {
  const f = await fixture(); const { cp } = await import('node:fs/promises'); const distribution = join(f.directory, 'dist'); await cp('dist', distribution, { recursive: true });
  const manifestPath = join(distribution, 'plugins/auth-single-user/0.1.0/aork.plugin.json'); const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); manifest.serviceModes = { 'aork.authorization@1': 'multi-provider' }; await writeFile(manifestPath, JSON.stringify(manifest));
  const marker = join(f.directory, 'selected-auth-imported');
  await archive(f.archive, { id: 'selected-auth', provides: ['aork.authorization@1'], serviceModes: { 'aork.authorization@1': 'multi-provider' }, maintenance: 'maintenance.js' }, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'imported');export function activate(c){c.provide('aork.authorization@1',{inspect:()=>({state:'unauthenticated'}),accessUrl:origin=>origin+'/selected-auth',exchangeToken:()=>{},verifyCsrf:()=>{}});}`);
  const input = JSON.parse(await readFile(f.archive, 'utf8')); const bytes = Buffer.from('export function maintain(c,action){return {owner:c.pluginId,action};}'); input.members.push({ path: 'maintenance.js', type: 'file', data: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') }); await writeFile(f.archive, JSON.stringify(input));
  f.profile.plugins.push({ id: 'selected-auth', version: '1.0.0', enabled: true }); f.profile.services = { 'aork.authorization@1': 'selected-auth' }; await writeFile(f.profileFile, JSON.stringify(f.profile));
  await cli('plugin', 'install', f.archive, '--data-dir', f.dataDir, '--profile', f.profileFile, '--distribution-dir', distribution);
  expect(JSON.parse((await cli('access', 'rotate', '--data-dir', f.dataDir, '--distribution-dir', distribution)).stdout)).toEqual({ owner: 'selected-auth', action: 'rotate' });
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(JSON.parse((await cli('access', 'recover', '--data-dir', f.dataDir, '--distribution-dir', distribution)).stdout)).toMatchObject({ action: 'recover', sessionsRevoked: true });
  const restored = JSON.parse((await cli('doctor', '--data-dir', f.dataDir, '--distribution-dir', distribution)).stdout).profile;
  expect(restored.services['aork.authorization@1']).toBe('auth-single-user'); expect(restored.plugins.find((plugin: {id:string})=>plugin.id==='selected-auth').enabled).toBe(false);
  expect(restored.ui.providers['aork.auth.login@1']).toBe('auth-single-user:login'); expect(restored.ui.providers['aork.auth.controls@1']).toBe('auth-single-user:controls');
  const host = await startHost({ dataDir: f.dataDir, distributionDir: distribution, port: 0, insecureLoopback: true }); cleanup.push(() => host.close());
  const login = await fetch(host.accessUrl!, { redirect: 'manual' }); expect(login.status).toBe(303); const Cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  expect(await (await fetch(`${host.url}/api/queries/auth.status`, { headers: { Cookie } })).json()).toMatchObject({ state: 'authenticated' }); await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
});

for (const source of ['server', 'ui'] as const) test(`a ${source}-required service remains mandatory when also declared optional, before any entry imports`, async () => {
  const f = await fixture(); await archive(f.archive); const original = JSON.parse((await install(f)).stdout).profile;
  const marker = join(f.directory, 'mandatory-entry-imported'); const malformed = join(f.directory, 'required.aork-plugin');
  await archive(malformed, { id: 'required-overlap', optionalRequires: ['demo.absent@1'], ...(source === 'server' ? { requires: ['demo.absent@1'] } : { client: 'client.js', ui: { providers: [{ id: 'home', contract: 'aork.workbench.home@1', requires: ['demo.absent@1'] }] } }) }, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'imported');export function activate(c){c.service('demo.absent@1');}`);
  if (source === 'ui') { const input = JSON.parse(await readFile(malformed, 'utf8')); const bytes = Buffer.from('export function activate(c){c.registerView("home",()=>null);}'); input.members.push({ path: 'client.js', type: 'file', data: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') }); await writeFile(malformed, JSON.stringify(input)); }
  f.profile.plugins.push({ id: 'required-overlap', version: '1.0.0', enabled: true }); await writeFile(f.profileFile, JSON.stringify(f.profile));
  expect((await cli('plugin', 'install', malformed, '--data-dir', f.dataDir, '--profile', f.profileFile).catch(error => error)).stderr).toContain('SERVICE_MISSING');
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  const host = await startHost({ dataDir: f.dataDir, port: 0, insecureLoopback: true }); cleanup.push(() => host.close());
  const login = await fetch(host.accessUrl!, { redirect: 'manual' }); const Cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const snapshot = await (await fetch(`${host.url}/api/queries/plugins.diagnostics`, { headers: { Cookie } })).json(); expect(snapshot.profile).toEqual(original); expect(snapshot.rejected.code).toBe('SERVICE_MISSING'); await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('profile UI rejection retains the safe package, contract and correction in doctor and protected diagnostics', async () => {
  const f = await fixture(); const first = await startHost({ dataDir: f.dataDir, port: 0, insecureLoopback: true }); const original = await (await fetch(`${first.url}/api/bootstrap`)).json(); await first.close();
  f.profile.ui.providers['aork.workbench.home@1'] = 'workbench:absent'; f.profile.plugins.find((plugin:{id:string})=>plugin.id==='agent-profiles').config = { masterKeyFile: '/private-profile-diag-secret' }; await writeFile(f.profileFile, JSON.stringify(f.profile));
  const failure = await cli('profile', 'apply', f.profileFile, '--data-dir', f.dataDir).catch(error => error);
  expect(failure.stderr).toContain('UI_PROVIDER_UNAVAILABLE'); expect(failure.stderr).not.toContain('private-profile-diag-secret');
  const doctor = JSON.parse((await cli('doctor', '--data-dir', f.dataDir)).stdout);
  expect(doctor.rejected).toMatchObject({ code: 'UI_PROVIDER_UNAVAILABLE', pluginId: 'workbench', version: '0.1.0', contract: 'aork.workbench.home@1', remedy: expect.any(String) }); expect(doctor.profile).toEqual(original.profile);
  const host = await startHost({ dataDir: f.dataDir, port: 0, insecureLoopback: true }); cleanup.push(() => host.close()); const login = await fetch(host.accessUrl!, { redirect: 'manual' }); const Cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const snapshot = await (await fetch(`${host.url}/api/queries/plugins.diagnostics`, { headers: { Cookie } })).json(); expect(snapshot.rejected).toEqual(doctor.rejected); expect(JSON.stringify(snapshot)).not.toContain('private-profile-diag-secret');
});
