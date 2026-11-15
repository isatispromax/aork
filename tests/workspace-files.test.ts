import { afterEach, expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bootstrap } from '@aork/sdk';
import { startHost } from '../apps/server/src/host.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'aork-files-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const external = join(directory, 'notes'); await mkdir(external); await mkdir(join(external, 'sources')); await writeFile(join(external, 'sources', 'note.md'), 'First line\nSecond line\n');
  const options = { dataDir: join(directory, 'data'), port: 0, insecureLoopback: true }; const host = await startHost(options); cleanup.push(() => host.close());
  const response = await fetch(host.accessUrl!, { redirect: 'manual' }); const session = response.headers.get('set-cookie')!.split(';')[0]!;
  const bootstrap = await (await fetch(`${host.url}/api/bootstrap`, { headers: { Cookie: session } })).json() as Bootstrap;
  const f = { directory, external, options, host, session, bootstrap }; const created = await command(f, 'workspace.createProject', { name: 'Research', workspace: { name: 'Notes', management: 'external', directory: external, access: 'read-write' } });
  expect(created.status).toBe(200); return { ...f, workspace: (await created.json()).result.workspace };
}
async function command(f: { host: { url: string }; session: string; bootstrap: Bootstrap }, name: string, payload: unknown) {
  return fetch(`${f.host.url}/api/commands/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: f.host.url, Cookie: f.session, 'X-Aork-CSRF': f.bootstrap.access.csrfToken! }, body: JSON.stringify({ apiVersion: 1, commandVersion: 1, commandId: crypto.randomUUID(), pluginGraphHash: f.bootstrap.pluginGraphHash, payload }) });
}
async function resource(f: Awaited<ReturnType<typeof fixture>>, name: string, parameters: Record<string, string> = {}, bytes?: Uint8Array) {
  return fetch(`${f.host.url}/api/resources/workspace.${name}?${new URLSearchParams({ workspaceId: f.workspace.id, ...parameters })}`, { method: bytes ? 'POST' : 'GET', headers: { Cookie: f.session, ...(bytes ? { 'Content-Type': 'application/octet-stream', Origin: f.host.url, 'X-Aork-CSRF': f.bootstrap.access.csrfToken!, 'X-Aork-Graph': f.bootstrap.pluginGraphHash } : {}) }, ...(bytes ? { body: Buffer.from(bytes) } : {}) });
}
test('registered Workspace files are browsed by stable identity and edited, uploaded and downloaded as actual bytes', async () => {
  const f = await fixture(); const list = await resource(f, 'files', { path: '' }); expect(list.status).toBe(200);
  expect(await list.json()).toMatchObject({ entries: [{ path: 'sources', kind: 'directory' }], truncated: false });
  const preview = await resource(f, 'preview', { path: 'sources/note.md', startLine: '2', lines: '1' }); expect(await preview.json()).toMatchObject({ text: 'Second line', startLine: 2, totalLines: 3 });
  const saved = await resource(f, 'text', { path: 'sources/note.md' }, Buffer.from('Edited\n')); expect(saved.status).toBe(200); expect(await readFile(join(f.external, 'sources/note.md'), 'utf8')).toBe('Edited\n');
  const upload = await resource(f, 'file', { path: '资料.bin' }, Uint8Array.from([0, 1, 255, 128])); expect(upload.status).toBe(200);
  expect(await readFile(join(f.external, '资料.bin'))).toEqual(Buffer.from([0, 1, 255, 128]));
  const downloaded = await resource(f, 'file', { path: '资料.bin' }); expect(downloaded.status).toBe(200); expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(Buffer.from([0, 1, 255, 128])); expect(downloaded.headers.get('content-disposition')).toContain('attachment');
});

test('a complete bounded text edit supports 256 KiB through the public resource transport without publishing contents in events', async () => {
  const f = await fixture(); const text = 'a'.repeat(100_000);
  const saved = await resource(f, 'text', { path: 'large.txt' }, Buffer.from(text)); expect(saved.status).toBe(200);
  expect(await readFile(join(f.external, 'large.txt'), 'utf8')).toBe(text);
  const events = await (await fetch(`${f.host.url}/api/events`, { headers: { Cookie: f.session } })).json(); expect(events.events).toHaveLength(1); expect(JSON.stringify(events)).not.toContain(text);
});

test('files reject traversal, outside aliases, changed root identity, read-only grants and stale editors with specific observable failures', async () => {
  const { symlink, rename } = await import('node:fs/promises'); const f = await fixture();
  await writeFile(join(f.directory, 'outside.txt'), 'private outside'); await symlink(f.directory, join(f.external, 'escape')); await symlink(join(f.external, 'sources'), join(f.external, 'alias'));
  for (const path of ['../outside.txt', '/etc/passwd', 'sources/../note.md', './sources/note.md', 'sources//note.md', 'escape/outside.txt', 'alias/note.md', 'sources\\note.md']) {
    const response = await resource(f, 'file', { path }); expect(response.status, path).toBeGreaterThanOrEqual(400); expect(await response.text()).not.toContain('private outside');
    const write = await resource(f, 'text', { path }, Buffer.from('escape attempt')); expect(write.status, path).toBeGreaterThanOrEqual(400);
  }
  expect(await readFile(join(f.directory, 'outside.txt'), 'utf8')).toBe('private outside');
  const preview = await (await resource(f, 'preview', { path: 'sources/note.md' })).json(); await writeFile(join(f.external, 'sources/note.md'), 'changed externally');
  const stale = await resource(f, 'text', { path: 'sources/note.md', expectedRevision: preview.revision }, Buffer.from('stale editor')); expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ error: { code: 'WORKSPACE_FILE_CHANGED' } }); expect(await readFile(join(f.external, 'sources/note.md'), 'utf8')).toBe('changed externally');
  expect((await command(f, 'workspace.edit', { id: f.workspace.id, name: 'References', access: 'read-only' })).status).toBe(200);
  expect((await resource(f, 'file', { path: 'sources/note.md' })).status).toBe(200);
  const readonly = await resource(f, 'text', { path: 'sources/note.md' }, Buffer.from('blocked')); expect(readonly.status).toBe(403); expect(await readonly.json()).toMatchObject({ error: { code: 'WORKSPACE_READ_ONLY' } });
  await rename(f.external, `${f.external}-old`); await mkdir(f.external); await writeFile(join(f.external, 'replacement.txt'), 'wrong root');
  const changed = await resource(f, 'files', { path: '' }); expect(changed.status).toBe(409); expect(await changed.json()).toMatchObject({ error: { code: 'WORKSPACE_DIRECTORY_CHANGED' } });
});

test('bounded search, text, binary transfers and download-only active content stay outside durable event contents', async () => {
  const f = await fixture(); await writeFile(join(f.external, 'active.html'), '<script>fetch("/api/commands/auth.logout",{method:"POST"})</script>');
  const html = await resource(f, 'file', { path: 'active.html' }); expect(html.headers.get('content-type')).toBe('application/octet-stream'); expect(html.headers.get('content-security-policy')).toContain('sandbox'); expect(html.headers.get('x-content-type-options')).toBe('nosniff');
  const search = await resource(f, 'search', { query: 'note' }); expect(await search.json()).toMatchObject({ entries: [{ path: 'sources/note.md' }], truncated: false });
  await writeFile(join(f.external, 'binary'), Buffer.from([0xff, 0x00])); const binary = await resource(f, 'preview', { path: 'binary' }); expect(binary.status).toBe(415);
  await writeFile(join(f.external, 'big.txt'), Buffer.alloc(256 * 1024 + 1, 97)); expect((await resource(f, 'preview', { path: 'big.txt' })).status).toBe(413); expect((await resource(f, 'file', { path: 'big.txt' })).status).toBe(200);
  const tooLarge = await resource(f, 'text', { path: 'too-big.txt' }, Buffer.alloc(256 * 1024 + 1)); expect(tooLarge.status).toBe(413);
  const exists = await resource(f, 'file', { path: 'sources/note.md' }, Buffer.from('overwrite')); expect(exists.status).toBe(409); expect(await readFile(join(f.external, 'sources/note.md'), 'utf8')).toBe('First line\nSecond line\n');
  const missingParent = await resource(f, 'file', { path: 'missing/file.txt' }, Buffer.from('new')); expect(missingParent.status).toBe(404);
  for (const params of [{ startLine: '0' }, { lines: '501' }, { lines: 'invalid' }]) expect((await resource(f, 'preview', { path: 'sources/note.md', ...params })).status).toBe(400);
  const anonymous = await fetch(`${f.host.url}/api/resources/workspace.file?${new URLSearchParams({ workspaceId: f.workspace.id, path: 'sources/note.md' })}`); expect(anonymous.status).toBe(401);
  const badOrigin = await fetch(`${f.host.url}/api/resources/workspace.file?${new URLSearchParams({ workspaceId: f.workspace.id, path: 'bad' })}`, { method: 'POST', headers: { Cookie: f.session, Origin: 'https://elsewhere.invalid', 'Content-Type': 'application/octet-stream' }, body: 'bad' }); expect(badOrigin.status).toBe(403);
});

test('an installed writer participant denies unknown ownership and holds overlapping directory permission until awaited writing finishes', async () => {
  const { cp } = await import('node:fs/promises'); const { maintainProfile } = await import('../apps/server/src/host.js'); const f = await fixture(); await f.host.close();
  const distributionDir = join(f.directory, 'distribution'); await cp('dist', distributionDir, { recursive: true }); const directory = join(distributionDir, 'plugins', 'writer-participant', '0.1.0'); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'aork.plugin.json'), JSON.stringify({ manifestVersion: 1, id: 'writer-participant', version: '0.1.0', sdkRange: '^0.1.0', server: 'server.js', requires: ['aork.workspace@1'], ui: { providers: [] } }));
  await writeFile(join(directory, 'server.js'), `import {writeFile} from 'node:fs/promises'; import {join} from 'node:path';
export function activate(context) { const workspace=context.service('aork.workspace@1'); let state={state:'unclaimed'},held=false,release; const stop=workspace.registerWriterParticipant({inspect(){return state}});
context.command('writer.status',{access:'authenticated',execute(payload){state={state:payload.state,reason:'Lifecycle owner is '+payload.state};return state}});
context.query('writer.status',{access:'authenticated',execute(){return {held,state}}});
context.command('writer.forget',{access:'authenticated',execute(){stop();return null}});
context.command('writer.hold',{access:'authenticated',execute(payload){return workspace.withWritePermission(payload.id,async current=>{held=true;await new Promise(resolve=>{release=resolve});await writeFile(join(current.directory,'participant.txt'),'completed under permission');held=false;return {status:'completed'}})}});
context.command('writer.release',{access:'authenticated',execute(){release?.();return null}}); return stop; }`);
  const profile = structuredClone(f.bootstrap.profile); profile.plugins.push({ id: 'writer-participant', version: '0.1.0', enabled: true }); await maintainProfile({ dataDir: f.options.dataDir, distributionDir, profile });
  f.host = await startHost({ ...f.options, port: Number(new URL(f.host.url).port), distributionDir }); cleanup.push(() => f.host.close()); f.bootstrap = await (await fetch(`${f.host.url}/api/bootstrap`, { headers: { Cookie: f.session } })).json(); expect(f.bootstrap.diagnostics).toEqual([]);
  const other = await command(f, 'workspace.create', { projectId: f.workspace.projectId, workspace: { name: 'Overlapping', management: 'external', directory: join(f.external, 'sources'), access: 'read-write' } }); const child = (await other.json()).result;
  await command(f, 'writer.status', { state: 'unknown' }); const unknown = await resource(f, 'file', { path: 'unknown.txt' }, Buffer.from('must fail')); expect(unknown.status).toBe(409); expect(await unknown.json()).toMatchObject({ error: { code: 'WORKSPACE_WRITER_UNKNOWN' } });
  await command(f, 'writer.status', { state: 'blocked' }); expect((await resource(f, 'file', { path: 'blocked.txt' }, Buffer.from('must fail'))).status).toBe(409);
  await command(f, 'writer.status', { state: 'unclaimed' }); const held = command(f, 'writer.hold', { id: f.workspace.id });
  await expect.poll(async () => (await (await fetch(`${f.host.url}/api/queries/writer.status`, { headers: { Cookie: f.session } })).json()).held).toBe(true);
  const overlap = await resource(f, 'file', { workspaceId: child.id, path: 'competing.txt' }, Buffer.from('must fail')); expect(overlap.status).toBe(409); expect(await overlap.json()).toMatchObject({ error: { code: 'WORKSPACE_WRITE_BUSY' } });
  await command(f, 'writer.release', null); expect(await (await held).json()).toEqual({status:'completed'}); expect(await readFile(join(f.external, 'participant.txt'), 'utf8')).toBe('completed under permission');
  expect((await resource(f, 'file', { workspaceId: child.id, path: 'after.txt' }, Buffer.from('allowed'))).status).toBe(200);
  await command(f, 'writer.forget', null); expect((await resource(f, 'file', { path: 'forgotten.txt' }, Buffer.from('must fail'))).status).toBe(409);
});

test('filesystem write failures leave no success target or upload debris and bounded listing remains usable after restart', async () => {
  const { chmod, readdir } = await import('node:fs/promises'); const f = await fixture();
  await chmod(f.external, 0o555);
  try { const denied = await resource(f, 'file', { path: 'denied.txt' }, Buffer.from('must not persist')); expect(denied.status).toBe(400); expect(await denied.json()).toMatchObject({ error: { code: 'WORKSPACE_FILE_FAILED', message: 'The server denied filesystem access' } }); } finally { await chmod(f.external, 0o755); }
  expect(await readdir(f.external)).toEqual(['sources']);
  expect((await resource(f, 'file', { path: 'after.txt' }, Buffer.from('survives restart'))).status).toBe(200);
  await Promise.all(Array.from({ length: 505 }, (_, index) => writeFile(join(f.external, `entry-${index}.txt`), 'x')));
  const listing = await (await resource(f, 'files', { path: '' })).json(); expect(listing.entries).toHaveLength(500); expect(listing.truncated).toBe(true);
  const port = Number(new URL(f.host.url).port); await f.host.close(); f.host = await startHost({ ...f.options, port }); cleanup.push(() => f.host.close());
  expect(await (await resource(f, 'file', { path: 'after.txt' })).text()).toBe('survives restart');
});

test('oversized transfer declarations retain a specific 413 response at the public transport boundary', async () => {
  const { request } = await import('node:http'); const f = await fixture();
  const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const pending = request(`${f.host.url}/api/resources/workspace.file?${new URLSearchParams({ workspaceId: f.workspace.id, path: 'oversized.bin' })}`, { method: 'POST', headers: { Cookie: f.session, Origin: f.host.url, 'X-Aork-CSRF': f.bootstrap.access.csrfToken!, 'X-Aork-Graph': f.bootstrap.pluginGraphHash, 'Content-Type': 'application/octet-stream', 'Content-Length': String(8 * 1024 * 1024 + 1) } }, response => {
      let body = ''; response.on('data', chunk => { body += String(chunk); }); response.on('end', () => { pending.destroy(); resolve({ status: response.statusCode!, body }); });
    }); pending.on('error', reject); pending.end();
  });
  expect(response.status).toBe(413); expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'REQUEST_TOO_LARGE' } });
});

test('UTF-8 text editing preserves an existing byte-order mark instead of silently deleting file bytes', async () => {
  const f = await fixture(); const text = '\ufeffRésumé\n'; await writeFile(join(f.external, 'utf8.txt'), text);
  const preview = await (await resource(f, 'preview', { path: 'utf8.txt' })).json(); expect(preview.text).toBe(text);
  const saved = await resource(f, 'text', { path: 'utf8.txt', expectedRevision: preview.revision }, Buffer.from(preview.text)); expect(saved.status).toBe(200); expect(await readFile(join(f.external, 'utf8.txt'), 'utf8')).toBe(text);
});

test('dangling leaf symlinks reject upload and text writes without replacing the link or leaving temporary files', async () => {
  const { symlink, lstat, readlink, readdir } = await import('node:fs/promises'); const f = await fixture();
  const missingTarget = join(f.directory, 'missing-outside-target');
  for (const name of ['upload-link', 'text-link']) await symlink(missingTarget, join(f.external, name));
  for (const [resourceName, path] of [['file', 'upload-link'], ['text', 'text-link']] as const) {
    const rejected = await resource(f, resourceName, { path }, Buffer.from('must not replace a link'));
    expect(rejected.status).toBe(403); expect(await rejected.json()).toMatchObject({ error: { code: 'WORKSPACE_SYMLINK_REJECTED' } });
    expect((await lstat(join(f.external, path))).isSymbolicLink()).toBe(true); expect(await readlink(join(f.external, path))).toBe(missingTarget);
  }
  expect((await resource(f, 'file', { path: 'new-upload.txt' }, Buffer.from('new bytes'))).status).toBe(200);
  expect((await resource(f, 'text', { path: 'new-text.txt' }, Buffer.from('new text'))).status).toBe(200);
  expect(await readFile(join(f.external, 'new-upload.txt'), 'utf8')).toBe('new bytes'); expect(await readFile(join(f.external, 'new-text.txt'), 'utf8')).toBe('new text');
  expect((await readdir(f.external)).sort()).toEqual(['new-text.txt', 'new-upload.txt', 'sources', 'text-link', 'upload-link']);
});
