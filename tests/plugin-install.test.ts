import { afterEach, expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile, cp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { startHost } from '../apps/server/src/host.js';

const execute = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'aork-install-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return { directory, dataDir: join(directory, 'data'), archive: join(directory, 'quiet.aork-plugin') };
}
const hostDigest = async () => createHash('sha256').update(await readFile('dist/server/main.mjs')).digest('hex');
const cli = (...args: string[]) => execute(process.execPath, ['dist/server/main.mjs', ...args]);

async function rewriteArchive(archive: string, change: (manifest: any, files: Map<string, Buffer>) => void) {
  const input = JSON.parse(await readFile(archive, 'utf8'));
  const files = new Map<string, Buffer>(input.members.map((member: { path: string; data: string }) => [member.path, Buffer.from(member.data, 'base64')]));
  const manifest = JSON.parse(files.get('aork.plugin.json')!.toString());
  change(manifest, files);
  files.set('aork.plugin.json', Buffer.from(JSON.stringify(manifest)));
  input.members = [...files].map(([path, bytes]) => ({ path, type: 'file', data: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') }));
  await writeFile(archive, JSON.stringify(input));
}

test('a separately built archive installs candidates without selecting them or rebuilding the Host', async () => {
  const { dataDir, archive } = await fixture();
  const before = await hostDigest();
  await execute(process.execPath, ['scripts/plugin-build.mjs', '--dir', 'examples/quiet-workbench', '--out', archive]);
  const installed = JSON.parse((await cli('plugin', 'install', archive, '--data-dir', dataDir)).stdout);
  expect(installed).toMatchObject({ installed: { id: 'quiet-workbench', version: '0.1.0' }, selected: false });
  const catalog = JSON.parse((await cli('doctor', '--data-dir', dataDir)).stdout).catalog;
  expect(catalog).toContainEqual({ id: 'quiet-workbench', version: '0.1.0', source: 'installed', enabled: false });
  expect(await hostDigest()).toBe(before);
  const host = await startHost({ dataDir, port: 0 });
  cleanup.push(() => host.close());
  const boot = await (await fetch(`${host.url}/api/bootstrap`)).json();
  expect(boot.ui.providers['aork.workbench.layout@1']).toBe('workbench:layout');
  expect(boot.plugins.some((plugin: { id: string }) => plugin.id === 'quiet-workbench')).toBe(false);
  expect((await cli('plugin', 'install', archive, '--data-dir', dataDir).catch(error => error)).stderr).toContain('ELOCKED');
  await host.close();
  expect((await cli('plugin', 'install', archive, '--data-dir', dataDir).catch(error => error)).stderr).toContain('FRESH_INSTANCE_REQUIRED');
});

test('an initial explicit profile selects the independent layout, ordered extensions, theme and icons with persistent service settings', async () => {
  const { directory, dataDir, archive } = await fixture();
  await execute(process.execPath, ['scripts/plugin-build.mjs', '--dir', 'examples/quiet-workbench', '--out', archive]);
  const profile = JSON.parse(await readFile('profiles/personal-server.json', 'utf8'));
  profile.plugins.push({ id: 'quiet-workbench', version: '0.1.0', enabled: true });
  profile.ui.providers['aork.workbench.layout@1'] = 'quiet-workbench:layout';
  profile.ui.providers['aork.ui.theme@1'] = 'quiet-workbench:theme';
  profile.ui.providers['aork.ui.icons@1'] = 'quiet-workbench:icons';
  profile.ui.extensions = [{ id: 'quiet-workbench:service', order: 20, hidden: false }, { id: 'quiet-workbench:privacy', order: 10, hidden: false }, { id: 'quiet-workbench:extra', order: 0, hidden: true }];
  const file = join(directory, 'profile.json');
  await writeFile(file, JSON.stringify(profile));
  expect(JSON.parse((await cli('plugin', 'install', archive, '--data-dir', dataDir, '--profile', file)).stdout).selected).toBe(true);
  const first = await startHost({ dataDir, port: 0, insecureLoopback: true });
  cleanup.push(() => first.close());
  const auth = await fetch(first.accessUrl!, { redirect: 'manual' });
  const cookie = auth.headers.get('set-cookie')!.split(';')[0]!;
  const before = await (await fetch(`${first.url}/api/bootstrap`, { headers: { Cookie: cookie } })).json();
  expect(before).toMatchObject({ apiVersion: 1, profile: { ui: { providers: { 'aork.workbench.layout@1': 'quiet-workbench:layout' } } }, access: { state: 'authenticated' } });
  expect(before.plugins.find((plugin: { id: string }) => plugin.id === 'quiet-workbench').styles).toEqual([expect.stringMatching(/^\/plugins\/[a-f0-9]{64}\/client.css$/)]);
  const send = (hash: string, label: string) => fetch(`${first.url}/api/commands/quiet.settings.save`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: first.url, Cookie: cookie, 'X-Aork-CSRF': before.access.csrfToken }, body: JSON.stringify({ apiVersion: 1, commandId: crypto.randomUUID(), pluginGraphHash: hash, payload: { label } }) });
  const stale = await send('0'.repeat(64), 'must not save');
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: { code: 'RELOAD_REQUIRED' } });
  expect(await (await send(before.pluginGraphHash, '研究工作台')).json()).toEqual({ label: '研究工作台' });
  await first.close();
  const second = await startHost({ dataDir, port: 0, insecureLoopback: true });
  cleanup.push(() => second.close());
  const nextAuth = await fetch(second.accessUrl!, { redirect: 'manual' });
  const nextCookie = nextAuth.headers.get('set-cookie')!.split(';')[0]!;
  expect(await (await fetch(`${second.url}/api/queries/quiet.settings`, { headers: { Cookie: nextCookie } })).json()).toEqual({ label: '研究工作台' });
  const after = await (await fetch(`${second.url}/api/bootstrap`)).json();
  expect(after.hostEpoch).not.toBe(before.hostEpoch);
  expect(after.pluginGraphHash).toBe(before.pluginGraphHash);
});

for (const [name, invalid, code] of [
  ['archive traversal', (_manifest: any, files: Map<string, Buffer>) => files.set('../outside.js', Buffer.from('export {}')), 'PLUGIN_ARCHIVE_INVALID'],
  ['an absolute member', (_manifest: any, files: Map<string, Buffer>) => files.set('/outside.js', Buffer.from('export {}')), 'PLUGIN_ARCHIVE_INVALID'],
  ['an undeclared member', (_manifest: any, files: Map<string, Buffer>) => files.set('extra.js', Buffer.from('export {}')), 'PLUGIN_FILE_UNDECLARED'],
  ['an incompatible SDK', (manifest: any) => { manifest.sdkRange = '^99.0.0'; }, 'SDK_INCOMPATIBLE'],
  ['an external server entry', (manifest: any) => { manifest.server = 'https://example.com/server.js'; }, 'canonical relative package path'],
  ['an unknown native addon', (manifest: any, files: Map<string, Buffer>) => { manifest.assets.push('extra.node'); files.set('extra.node', Buffer.from('native')); }, 'PLUGIN_NATIVE_UNSUPPORTED'],
  ['an unsupported shared browser entry', (_manifest: any, files: Map<string, Buffer>) => files.set('client.js', Buffer.from('import "react-dom/server";export function activate(){}')), 'PLUGIN_IMPORT_UNSUPPORTED'],
  ['an unbundled server dependency', (_manifest: any, files: Map<string, Buffer>) => files.set('server.js', Buffer.from('import "zod";export function activate(){}')), 'PLUGIN_IMPORT_UNSUPPORTED'],
  ['a computed import', (_manifest: any, files: Map<string, Buffer>) => files.set('client.js', Buffer.from('export function activate(){return import(globalThis.pluginUrl)}')), 'PLUGIN_IMPORT_UNSUPPORTED'],
  ['a private server import in the client', (_manifest: any, files: Map<string, Buffer>) => files.set('client.js', Buffer.from('import "./server.js";export function activate(){}')), 'PLUGIN_IMPORT_UNSUPPORTED'],
  ['a bundled React runtime', (_manifest: any, files: Map<string, Buffer>) => files.set('client.js', Buffer.from('var ELEMENT=Symbol.for("react.transitional.element");export function activate(){}')), 'PLUGIN_REACT_DUPLICATE'],
  ['a CSS reference outside explicit assets', (_manifest: any, files: Map<string, Buffer>) => files.set('client.css', Buffer.from('.icon{background:url(../outside.svg)}')), 'PLUGIN_ASSET_INVALID'],
  ['a disguised native executable', (manifest: any, files: Map<string, Buffer>) => { manifest.assets.push('payload.bin'); files.set('payload.bin', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0])); }, 'PLUGIN_NATIVE_UNSUPPORTED'],
] as const) test(`initial install rejects ${name} before executing server code`, async () => {
  const { directory, dataDir, archive } = await fixture();
  await execute(process.execPath, ['scripts/plugin-build.mjs', '--dir', 'examples/quiet-workbench', '--out', archive]);
  const marker = join(directory, 'executed');
  await rewriteArchive(archive, (manifest, files) => {
    files.set('server.js', Buffer.from(`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'executed');\n${files.get('server.js')}`));
    invalid(manifest, files);
  });
  const failure = await cli('plugin', 'install', archive, '--data-dir', dataDir).catch(error => error);
  expect(failure.stderr).toContain(code);
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('an initial archive refuses non-file members and duplicate paths', async () => {
  const { dataDir, archive } = await fixture();
  await execute(process.execPath, ['scripts/plugin-build.mjs', '--dir', 'examples/quiet-workbench', '--out', archive]);
  const input = JSON.parse(await readFile(archive, 'utf8'));
  const original = structuredClone(input);
  input.members.push({ path: 'link', type: 'symlink', data: '../outside', sha256: '' });
  await writeFile(archive, JSON.stringify(input));
  expect((await cli('plugin', 'install', archive, '--data-dir', dataDir).catch(error => error)).stderr).toContain('PLUGIN_ARCHIVE_INVALID');
  original.members.push(original.members[0]); await writeFile(archive, JSON.stringify(original));
  expect((await cli('plugin', 'install', archive, '--data-dir', dataDir).catch(error => error)).stderr).toContain('PLUGIN_ARCHIVE_INVALID');
});

test('the author build retains different CSS modules that share a basename', async () => {
  const { directory, archive } = await fixture();
  const source = join(directory, 'source'); await cp('examples/quiet-workbench', source, { recursive: true });
  await mkdir(join(source, 'src/left')); await mkdir(join(source, 'src/right'));
  await writeFile(join(source, 'src/left/style.module.css'), '.left { color: red; }');
  await writeFile(join(source, 'src/right/style.module.css'), '.right { color: blue; }');
  const client = await readFile(join(source, 'src/client.tsx'), 'utf8');
  // Keep the imports observably used so tree-shaking cannot hide a duplicate module identity.
  await writeFile(join(source, 'src/client.tsx'), `import left from './left/style.module.css';import right from './right/style.module.css';\n${client.replace("context.registerView('layout', Layout);", "context.registerView('layout', props => <div className={left.left + ' ' + right.right}><Layout {...props}/></div>);")}`);
  // The package remains independently authored; its only executable source dependencies are its SDK.
  await writeFile(join(source, 'src/server.ts'), 'export function activate() {}');
  await execute(process.execPath, ['scripts/plugin-build.mjs', '--dir', source, '--out', archive]);
  const output = JSON.parse(await readFile(archive, 'utf8'));
  const css = Buffer.from(output.members.find((member: { path: string }) => member.path.endsWith('.css')).data, 'base64').toString();
  expect(css).toMatch(/color:\s*red/);
  expect(css).toMatch(/color:\s*(?:blue|#00f)/);
});

test('an already installed exact candidate can be selected by lifecycle maintenance after Host startup', async () => {
  const { directory, dataDir, archive } = await fixture();
  await execute(process.execPath, ['scripts/plugin-build.mjs', '--dir', 'examples/quiet-workbench', '--out', archive]);
  await cli('plugin', 'install', archive, '--data-dir', dataDir);
  const host = await startHost({ dataDir, port: 0 }); cleanup.push(() => host.close()); await host.close();
  const profile = JSON.parse(await readFile('profiles/personal-server.json', 'utf8'));
  profile.plugins.push({ id: 'quiet-workbench', version: '0.1.0', enabled: true });
  profile.ui.providers['aork.workbench.layout@1'] = 'quiet-workbench:layout';
  const file = join(directory, 'profile.json'); await writeFile(file, JSON.stringify(profile));
  expect(JSON.parse((await cli('profile','apply',file,'--data-dir',dataDir)).stdout).profile.ui.providers['aork.workbench.layout@1']).toBe('quiet-workbench:layout');
  const restarted = await startHost({ dataDir, port: 0 }); cleanup.push(() => restarted.close());
  expect((await (await fetch(`${restarted.url}/api/bootstrap`)).json()).ui.providers['aork.workbench.layout@1']).toBe('quiet-workbench:layout');
});

test('a failed first Host bind still prevents new installation while allowing selection of an existing candidate', async () => {
  const { directory, dataDir, archive } = await fixture();
  await execute(process.execPath, ['scripts/plugin-build.mjs', '--dir', 'examples/quiet-workbench', '--out', archive]);
  await cli('plugin', 'install', archive, '--data-dir', dataDir);
  const occupied = createServer(); await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => occupied.close(error => error ? reject(error) : resolve())));
  const address = occupied.address(); if (!address || typeof address === 'string') throw new Error('Expected TCP fixture');
  await expect(startHost({ dataDir, port: address.port })).rejects.toMatchObject({ code: 'EADDRINUSE' });
  const profile = JSON.parse(await readFile('profiles/personal-server.json', 'utf8'));
  profile.plugins.push({ id: 'quiet-workbench', version: '0.1.0', enabled: true });
  const file = join(directory, 'profile.json'); await writeFile(file, JSON.stringify(profile));
  expect((await cli('plugin','install',archive,'--data-dir',dataDir).catch(error=>error)).stderr).toContain('FRESH_INSTANCE_REQUIRED');
  expect(JSON.parse((await cli('profile','apply',file,'--data-dir',dataDir)).stdout).profile.plugins).toContainEqual(expect.objectContaining({id:'quiet-workbench',enabled:true}));
});

test('independent server archives accept a bundled CommonJS helper declaration while rejecting actual unresolved calls', async () => {
  const { directory, archive } = await fixture();
  await execute(process.execPath, ['scripts/plugin-build.mjs', '--dir', 'plugins/agent-profiles', '--out', archive]);
  await rewriteArchive(archive, manifest => { manifest.id = 'agent-profiles-copy'; });
  const installed = JSON.parse((await cli('plugin', 'install', archive, '--data-dir', join(directory, 'good'))).stdout);
  expect(installed).toMatchObject({ installed: { id: 'agent-profiles-copy', version: '0.1.0' } });
  for (const [index, source] of [
    'function __require(){ return require("node:fs"); } export function activate(){ __require(); }',
    'function __require(){} export function activate(){ return __require("node:fs"); }',
  ].entries()) {
    await rewriteArchive(archive, (_manifest, files) => files.set('server.js', Buffer.from(source)));
    expect((await cli('plugin', 'install', archive, '--data-dir', join(directory, `bad-${index}`)).catch(error => error)).stderr).toContain('PLUGIN_IMPORT_UNSUPPORTED');
  }
});
