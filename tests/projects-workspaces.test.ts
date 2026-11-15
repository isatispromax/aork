import { afterEach, expect, test } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bootstrap } from '@aork/sdk';
import { repositoryNamespace } from '@aork/sdk/server';
import { startHost } from '../apps/server/src/host.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'aork-workspace-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const external = await mkdtemp(join(directory, 'plain-directory-'));
  const options = { dataDir: join(directory, 'data'), port: 0, insecureLoopback: true };
  const host = await startHost(options); cleanup.push(() => host.close());
  const response = await fetch(host.accessUrl!, { redirect: 'manual' });
  const session = response.headers.get('set-cookie')!.split(';')[0]!;
  const bootstrap = await (await fetch(`${host.url}/api/bootstrap`, { headers: { Cookie: session } })).json() as Bootstrap;
  return { directory, external, options, host, session, bootstrap };
}
async function query(url: string, session: string, name = 'workspace.overview') {
  return fetch(`${url}/api/queries/${name}`, { headers: { Cookie: session } });
}
async function command(f: Awaited<ReturnType<typeof fixture>>, name: string, payload: unknown, commandId: string = crypto.randomUUID()) {
  return fetch(`${f.host.url}/api/commands/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: f.host.url, Cookie: f.session, 'X-Aork-CSRF': f.bootstrap.access.csrfToken! }, body: JSON.stringify({ apiVersion: 1, commandVersion: 1, commandId, pluginGraphHash: f.bootstrap.pluginGraphHash, payload }) });
}

test('a non-Git directory becomes a distinct persistent Project and Workspace through an authenticated durable command', async () => {
  const f = await fixture();
  const response = await command(f, 'workspace.createProject', { name: 'Research', workspace: { name: 'Notes', management: 'external', directory: f.external, access: 'read-write' } });
  expect(response.status).toBe(200);
  const receipt = await response.json();
  expect(receipt).toMatchObject({ name: 'workspace.createProject', version: 1, outcome: 'completed', result: { project: { name: 'Research', status: 'open' }, workspace: { name: 'Notes', management: 'external', directory: await realpath(f.external), access: 'read-write' } } });
  expect(receipt.result.project.id).not.toBe(receipt.result.workspace.id);
  expect(receipt.events).toHaveLength(1); expect(receipt.events[0].seq).toMatch(/^[1-9][0-9]*$/);
  const initial = await (await query(f.host.url, f.session)).json(); expect(initial.projects).toHaveLength(1); expect(initial.workspaces[0].projectId).toBe(receipt.result.project.id);
  await f.host.close();
  const restarted = await startHost({ ...f.options, port: Number(new URL(f.host.url).port) }); cleanup.push(() => restarted.close());
  expect(await (await query(restarted.url, f.session)).json()).toEqual(initial);
});

test('canonical wire retries return the immutable receipt before touching the directory and reject changed command content', async () => {
  const f = await fixture(); const commandId = crypto.randomUUID();
  const payload = { name: '  Research  ', workspace: { name: 'Notes', management: 'external', directory: f.external, access: 'read-write' } };
  const first = await command(f, 'workspace.createProject', payload, commandId); expect(first.status).toBe(200); const saved = await first.json();
  const concurrent = await Promise.all([command(f, 'workspace.createProject', { workspace: payload.workspace, name: payload.name }, commandId), command(f, 'workspace.createProject', payload, commandId)]);
  for (const response of concurrent) expect(await response.json()).toEqual(saved);
  expect((await (await query(f.host.url, f.session)).json()).projects).toHaveLength(1);
  const changed = await command(f, 'workspace.createProject', { ...payload, name: 'Research' }, commandId); expect(changed.status).toBe(409); expect(await changed.json()).toMatchObject({ error: { code: 'COMMAND_ID_CONFLICT' } });
  await rm(f.external, { recursive: true });
  expect(await (await command(f, 'workspace.createProject', payload, commandId)).json()).toEqual(saved);
  const lookup = await fetch(`${f.host.url}/api/receipts/${commandId}`, { headers: { Cookie: f.session } }); expect(await lookup.json()).toEqual(saved);
  const events = await (await fetch(`${f.host.url}/api/events?after=0&limit=1`, { headers: { Cookie: f.session } })).json();
  expect(events.events).toHaveLength(1); expect(events.events[0]).toMatchObject({ ...saved.events[0], owner: 'workspace', type: 'workspace.projectCreated', visibility: 'browser', commandId });
  expect(JSON.stringify(events)).not.toContain('csrf'); expect(JSON.stringify(events)).not.toContain(f.bootstrap.access.identity);
});

test('directory and schema rejection leave no visible entity, receipt or event and the corrected command can reuse its ID', async () => {
  const f = await fixture(); const commandId = crypto.randomUUID();
  const invalid = await command(f, 'workspace.createProject', { name: 'Broken', workspace: { name: 'Missing', management: 'external', directory: join(f.directory, 'absent'), access: 'read-write' } }, commandId);
  expect(invalid.status).toBe(400); expect(await invalid.json()).toMatchObject({ error: { code: 'WORKSPACE_DIRECTORY_INVALID' } });
  const unexpected = await command(f, 'workspace.createProject', { name: 'Broken', credential: 'do-not-store', workspace: { name: 'Missing', management: 'managed' } }, commandId); expect(unexpected.status).toBe(400);
  expect(await (await query(f.host.url, f.session)).json()).toEqual({ projects: [], workspaces: [] });
  expect((await fetch(`${f.host.url}/api/receipts/${commandId}`, { headers: { Cookie: f.session } })).status).toBe(404);
  expect(await (await fetch(`${f.host.url}/api/events`, { headers: { Cookie: f.session } })).json()).toEqual({ events: [] });
  const corrected = await command(f, 'workspace.createProject', { name: 'Valid', workspace: { name: 'Managed', management: 'managed' } }, commandId); expect(corrected.status).toBe(200);
  const saved = await corrected.json(); expect(saved.result.workspace.management).toBe('managed'); expect(saved.result.workspace.scope.root).toBe(saved.result.workspace.directory);
});

test('a Project contains multiple stable Workspaces and editing or archiving never removes their directories or registration history', async () => {
  const f = await fixture();
  const created = await (await command(f, 'workspace.createProject', { name: 'Research', workspace: { name: 'Notes', management: 'external', directory: f.external, access: 'read-write' } })).json();
  const { project, workspace } = created.result;
  const addedResponse = await command(f, 'workspace.create', { projectId: project.id, workspace: { name: 'Drafts', management: 'managed' } }); expect(addedResponse.status).toBe(200);
  const added = (await addedResponse.json()).result;
  const renamed = await command(f, 'workspace.editProject', { id: project.id, name: 'Writing' }); expect(renamed.status).toBe(200);
  const edited = await command(f, 'workspace.edit', { id: workspace.id, name: 'Read-only notes', access: 'read-only' }); expect(edited.status).toBe(200);
  expect((await edited.json()).result).toMatchObject({ id: workspace.id, directory: workspace.directory, access: 'read-only' });
  expect((await command(f, 'workspace.archive', { id: added.id })).status).toBe(200);
  expect((await command(f, 'workspace.archiveProject', { id: project.id })).status).toBe(200);
  const overview = await (await query(f.host.url, f.session)).json();
  expect(overview.projects).toEqual([{ id: project.id, name: 'Writing', status: 'archived' }]); expect(overview.workspaces).toHaveLength(2);
  expect(overview.workspaces.find((item: { id: string }) => item.id === workspace.id).status).toBe('open');
  expect(await realpath(added.directory)).toBe(added.directory); expect(await realpath(f.external)).toBe(workspace.directory);
  const rejected = await command(f, 'workspace.create', { projectId: project.id, workspace: { name: 'Disallowed', management: 'external', directory: f.external, access: 'read-only' } }); expect(rejected.status).toBe(409);
  expect((await (await query(f.host.url, f.session)).json()).workspaces).toHaveLength(2);
});

test('a malformed Plugin result rolls back Project, Workspace, receipt and durable event together, and a repaired package can retry', async () => {
  const { cp, readFile, writeFile } = await import('node:fs/promises');
  const f = await fixture(); await f.host.close();
  const distributionDir = join(f.directory, 'distribution'); await cp('dist', distributionDir, { recursive: true });
  const server = join(distributionDir, 'plugins/workspace/0.1.0/server.js'); const original = await readFile(server, 'utf8');
  const changed = original.replace('result: prepared,', 'result: { ...prepared, project: { ...prepared.project, status: "invalid" } },'); expect(changed).not.toBe(original); await writeFile(server, changed);
  f.host = await startHost({ ...f.options, port: Number(new URL(f.host.url).port), distributionDir }); cleanup.push(() => f.host.close());
  f.bootstrap = await (await fetch(`${f.host.url}/api/bootstrap`, { headers: { Cookie: f.session } })).json();
  const commandId = crypto.randomUUID(); const payload = { name: 'Atomic', workspace: { name: 'Actual', management: 'external', directory: f.external, access: 'read-write' } };
  const rejected = await command(f, 'workspace.createProject', payload, commandId); expect(rejected.status).toBe(500); expect(await rejected.json()).toMatchObject({ error: { code: 'INVALID_COMMAND_RESULT' } });
  expect(await (await query(f.host.url, f.session)).json()).toEqual({ projects: [], workspaces: [] });
  expect((await fetch(`${f.host.url}/api/receipts/${commandId}`, { headers: { Cookie: f.session } })).status).toBe(404);
  expect(await (await fetch(`${f.host.url}/api/events`, { headers: { Cookie: f.session } })).json()).toEqual({ events: [] });
  await f.host.close(); await writeFile(server, original);
  f.host = await startHost({ ...f.options, port: Number(new URL(f.host.url).port), distributionDir }); cleanup.push(() => f.host.close());
  f.bootstrap = await (await fetch(`${f.host.url}/api/bootstrap`, { headers: { Cookie: f.session } })).json();
  expect((await command(f, 'workspace.createProject', payload, commandId)).status).toBe(200);
});

test('receipt identity and ordered bounded decimal event cursors survive local signing-key recovery', async () => {
  const { maintainAccess } = await import('../apps/server/src/host.js');
  const f = await fixture(); const commandId = crypto.randomUUID(); const payload = { name: 'Persistent', workspace: { name: 'Local', management: 'managed' } };
  const original = await command(f, 'workspace.createProject', payload, commandId); const originalText = await original.text(); const saved = JSON.parse(originalText);
  const edited = await command(f, 'workspace.editProject', { id: saved.result.project.id, name: 'Edited' }); expect(edited.status).toBe(200);
  const differentName = await command(f, 'workspace.archiveProject', { id: saved.result.project.id }, commandId); expect(differentName.status).toBe(409);
  const wrongVersion = await fetch(`${f.host.url}/api/commands/workspace.createProject`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: f.host.url, Cookie: f.session, 'X-Aork-CSRF': f.bootstrap.access.csrfToken! }, body: JSON.stringify({ apiVersion: 1, commandVersion: 2, commandId, pluginGraphHash: f.bootstrap.pluginGraphHash, payload }) });
  expect(await wrongVersion.json()).toMatchObject({ error: { code: 'COMMAND_ID_CONFLICT' } });
  const first = await (await fetch(`${f.host.url}/api/events?limit=1`, { headers: { Cookie: f.session } })).json(); const next = await (await fetch(`${f.host.url}/api/events?after=${first.events[0].seq}&limit=1`, { headers: { Cookie: f.session } })).json();
  expect(first.events[0].seq).toBe(saved.events[0].seq); expect(BigInt(next.events[0].seq)).toBeGreaterThan(BigInt(first.events[0].seq));
  for (const cursor of ['01', '-1', '1e2', '9223372036854775808', '9007199254740993.0']) expect((await fetch(`${f.host.url}/api/events?after=${cursor}`, { headers: { Cookie: f.session } })).status).toBe(400);
  expect((await fetch(`${f.host.url}/api/events?after=9007199254740993`, { headers: { Cookie: f.session } })).status).toBe(200);
  expect((await fetch(`${f.host.url}/api/events?limit=101`, { headers: { Cookie: f.session } })).status).toBe(400);
  expect((await fetch(`${f.host.url}/api/events`)).status).toBe(401); expect((await fetch(`${f.host.url}/api/receipts/${commandId}`)).status).toBe(401);
  const identity = f.bootstrap.access.identity; const port = Number(new URL(f.host.url).port); await f.host.close(); await maintainAccess({ dataDir: f.options.dataDir, action: 'recover' });
  f.host = await startHost({ ...f.options, port }); cleanup.push(() => f.host.close());
  expect((await query(f.host.url, f.session)).status).toBe(401);
  const exchange = await fetch(f.host.accessUrl!, { redirect: 'manual' }); f.session = exchange.headers.get('set-cookie')!.split(';')[0]!;
  f.bootstrap = await (await fetch(`${f.host.url}/api/bootstrap`, { headers: { Cookie: f.session } })).json(); expect(f.bootstrap.access.identity).toBe(identity);
  expect(await (await command(f, 'workspace.createProject', payload, commandId)).text()).toBe(originalText);
  expect((await (await query(f.host.url, f.session)).json()).projects[0].name).toBe('Edited');
  expect(await (await fetch(`${f.host.url}/api/events?limit=1`, { headers: { Cookie: f.session } })).json()).toEqual(first);
});

test('server realpaths, requested aliases and access scopes are preserved while invalid or replaced directories are rejected', async () => {
  const { symlink, writeFile, rename } = await import('node:fs/promises');
  const f = await fixture(); const alias = join(f.directory, 'alias'); await symlink(f.external, alias);
  const created = await command(f, 'workspace.createProject', { name: 'Aliases', workspace: { name: 'Readonly', management: 'external', directory: alias, access: 'read-only' } }); expect(created.status).toBe(200);
  const saved = (await created.json()).result; expect(saved.workspace).toMatchObject({ requestedDirectory: alias, directory: await realpath(f.external), access: 'read-only', scope: { root: await realpath(f.external), recursive: true } });
  const second = await command(f, 'workspace.create', { projectId: saved.project.id, workspace: { name: 'Same actual directory', management: 'external', directory: f.external, access: 'read-write' } }); expect(second.status).toBe(200); expect((await second.json()).result.id).not.toBe(saved.workspace.id);
  const file = join(f.directory, 'file'); await writeFile(file, 'not a directory');
  for (const directory of [file, 'relative', join(f.directory, 'missing')]) expect((await command(f, 'workspace.create', { projectId: saved.project.id, workspace: { name: 'Invalid', management: 'external', directory, access: 'read-write' } })).status).toBe(400);
  await rename(f.external, `${f.external}-moved`);
  const edit = await command(f, 'workspace.edit', { id: saved.workspace.id, name: 'Changed', access: 'read-write' }); expect(edit.status).toBe(400);
  const overview = await (await query(f.host.url, f.session)).json(); expect(overview.projects).toHaveLength(1); expect(overview.workspaces).toHaveLength(2); expect(overview.workspaces[0].name).toBe('Readonly');
});

test('an operating-system file-size failure rejects a durable write without partial entities, receipts or events and requires restart before new writes', async () => {
  const { spawn } = await import('node:child_process');
  const f = await fixture(); const port = Number(new URL(f.host.url).port); await f.host.close();
  const child = spawn('python3', ['-c', 'import os,resource,signal,sys; resource.setrlimit(resource.RLIMIT_FSIZE,(262144,262144)); signal.signal(signal.SIGXFSZ,signal.SIG_IGN); os.execv(sys.argv[1],sys.argv[1:])', process.execPath, 'dist/server/main.mjs', '--data-dir', f.options.dataDir, '--port', String(port), '--insecure-loopback']);
  const done = new Promise<void>(resolve => child.once('exit', () => resolve()));
  cleanup.push(async () => { child.kill('SIGTERM'); await done; });
  const accessUrl = await new Promise<string>((resolve, reject) => { let output = ''; let stderr = ''; child.stdout.on('data', chunk => { output += String(chunk); const match = output.match(/"accessUrl":"([^"]+)"/); if (match) resolve(match[1]!); }); child.stderr.on('data', chunk => { stderr += String(chunk); }); child.once('error', reject); child.once('exit', code => reject(new Error(`Limited Host exited ${code}: ${stderr}`))); });
  const exchange = await fetch(accessUrl, { redirect: 'manual' }); f.session = exchange.headers.get('set-cookie')!.split(';')[0]!;
  f.bootstrap = await (await fetch(`${f.host.url}/api/bootstrap`, { headers: { Cookie: f.session } })).json();
  const accepted: unknown[] = []; let failedId = ''; let failedPayload: unknown;
  for (let index = 0; index < 40; index++) {
    const commandId = crypto.randomUUID(); const payload = { name: `Research ${index}`, workspace: { name: 'Actual', management: 'external', directory: f.external, access: 'read-write' } };
    const response = await command(f, 'workspace.createProject', payload, commandId);
    if (response.status === 200) accepted.push(await response.json());
    else { expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ error: { code: 'STORAGE_UNAVAILABLE' } }); failedId = commandId; failedPayload = payload; break; }
  }
  expect(failedId).not.toBe(''); expect(accepted.length).toBeGreaterThan(0);
  const overview = await (await query(f.host.url, f.session)).json(); expect(overview.projects).toHaveLength(accepted.length); expect(overview.workspaces).toHaveLength(accepted.length);
  const events = await (await fetch(`${f.host.url}/api/events`, { headers: { Cookie: f.session } })).json(); expect(events.events).toHaveLength(accepted.length);
  expect((await fetch(`${f.host.url}/api/receipts/${failedId}`, { headers: { Cookie: f.session } })).status).toBe(404);
  expect((await command(f, 'workspace.createProject', failedPayload, failedId)).status).toBe(503);
  child.kill('SIGTERM'); await done;
  f.host = await startHost({ ...f.options, port }); cleanup.push(() => f.host.close());
  f.bootstrap = await (await fetch(`${f.host.url}/api/bootstrap`, { headers: { Cookie: f.session } })).json();
  expect(await (await query(f.host.url, f.session)).json()).toEqual(overview);
  expect((await command(f, 'workspace.createProject', failedPayload, failedId)).status).toBe(200);
});

test('a Plugin cannot register a mutating RETURNING statement as a transaction-free read', async () => {
  const { cp, mkdir, writeFile } = await import('node:fs/promises');
  const f = await fixture(); await f.host.close();
  const distributionDir = join(f.directory, 'distribution'); await cp('dist', distributionDir, { recursive: true });
  const directory = join(distributionDir, 'plugins/fixture/0.1.0'); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'aork.plugin.json'), JSON.stringify({ manifestVersion: 1, id: 'fixture', version: '0.1.0', sdkRange: '^0.1.0', server: 'server.js', ui: { providers: [] } }));
  await writeFile(join(directory, 'server.js'), `export const persistence = { namespace:'plugin_fixture__', migrations:[{version:1,statements:['CREATE TABLE plugin_fixture__items (id TEXT PRIMARY KEY)']}], statements:{read:{sql:'INSERT INTO plugin_fixture__items (id) VALUES (?) RETURNING id',mode:'read'}} }; export function activate(context) { context.query('fixture.items',{access:'authenticated',execute:()=>context.repository.all('read',['unsafe'])}); }`);
  const profile = structuredClone(f.bootstrap.profile); profile.plugins.push({ id: 'fixture', version: '0.1.0', enabled: true });
  const { maintainProfile } = await import('../apps/server/src/host.js'); await maintainProfile({ dataDir: f.options.dataDir, distributionDir, profile });
  f.host = await startHost({ ...f.options, distributionDir }); cleanup.push(() => f.host.close());
  const bootstrap = await (await fetch(`${f.host.url}/api/bootstrap`)).json(); expect(bootstrap.access.state).toBe('unavailable'); expect(bootstrap.diagnostics).toContainEqual(expect.objectContaining({ code: 'PLUGIN_ACTIVATION_FAILED', pluginId: 'fixture' }));
});

test('a rejected async transaction participant is contained and the real Host remains alive with no partial command', async () => {
  const { spawn } = await import('node:child_process'); const { cp, readFile, writeFile } = await import('node:fs/promises');
  const f = await fixture(); const port = Number(new URL(f.host.url).port); await f.host.close();
  const distributionDir = join(f.directory, 'distribution'); await cp('dist', distributionDir, { recursive: true });
  const server = join(distributionDir, 'plugins/workspace/0.1.0/server.js'); const original = await readFile(server, 'utf8');
  const changed = original.replace('execute(_payload, prepared, transaction) {', 'async execute(_payload, prepared, transaction) { throw new Error("private-async-fault");'); expect(changed).not.toBe(original); await writeFile(server, changed);
  const child = spawn(process.execPath, ['dist/server/main.mjs', '--data-dir', f.options.dataDir, '--distribution-dir', distributionDir, '--port', String(port), '--insecure-loopback']);
  const done = new Promise<void>(resolve => child.once('exit', () => resolve())); cleanup.push(async () => { child.kill('SIGTERM'); await done; });
  await new Promise<void>((resolve, reject) => { let output = ''; let stderr = ''; child.stdout.on('data', chunk => { output += String(chunk); if (output.includes('host.listening')) resolve(); }); child.stderr.on('data', chunk => { stderr += String(chunk); }); child.once('error', reject); child.once('exit', code => reject(new Error(`Host exited ${code}: ${stderr}`))); });
  f.bootstrap = await (await fetch(`${f.host.url}/api/bootstrap`, { headers: { Cookie: f.session } })).json();
  const commandId = crypto.randomUUID(); const response = await command(f, 'workspace.createProject', { name: 'Atomic', workspace: { name: 'Actual', management: 'external', directory: f.external, access: 'read-write' } }, commandId);
  expect(response.status).toBe(500); expect(await response.json()).toMatchObject({ error: { code: 'TRANSACTION_ASYNC' } });
  expect(await (await query(f.host.url, f.session)).json()).toEqual({ projects: [], workspaces: [] });
  expect((await fetch(`${f.host.url}/api/receipts/${commandId}`, { headers: { Cookie: f.session } })).status).toBe(404);
  expect(await (await fetch(`${f.host.url}/api/events`, { headers: { Cookie: f.session } })).json()).toEqual({ events: [] });
});

test('valid dotted and hyphenated installed Plugin IDs own distinct repository namespaces', async () => {
  const { cp, mkdir, writeFile } = await import('node:fs/promises');
  const f = await fixture(); const port = Number(new URL(f.host.url).port); await f.host.close();
  const distributionDir = join(f.directory, 'distribution'); await cp('dist', distributionDir, { recursive: true }); const profile = structuredClone(f.bootstrap.profile);
  for (const [id, queryName] of [['notes.example', 'fixture.dotted'], ['notes-example', 'fixture.hyphenated']] as const) {
    const directory = join(distributionDir, 'plugins', id, '0.1.0'); await mkdir(directory, { recursive: true });
    const table = `${repositoryNamespace(id)}items`;
    await writeFile(join(directory, 'aork.plugin.json'), JSON.stringify({ manifestVersion: 1, id, version: '0.1.0', sdkRange: '^0.1.0', server: 'server.js', ui: { providers: [] } }));
    await writeFile(join(directory, 'server.js'), `export const persistence = { namespace:${JSON.stringify(repositoryNamespace(id))}, migrations:[{version:1,statements:['CREATE TABLE ${table} (value TEXT PRIMARY KEY)']}], statements:{read:{sql:'SELECT value FROM ${table}',mode:'read'},write:{sql:'INSERT INTO ${table} (value) VALUES (?)',mode:'write'}} }; export function activate(context) { context.query('${queryName}',{access:'authenticated',execute:()=>context.repository.all('read')}); context.durableCommand('${queryName}.add',{version:1,payload:{parse(value){if(value!==null)throw Error('invalid');return null}},result:{parse(value){if(value!=='saved')throw Error('invalid');return value}},events:{},execute(_payload,_prepared,tx){context.repository.run(tx,'write',['${id}']);return{result:'saved',events:[]}}}); }`);
    profile.plugins.push({ id, version: '0.1.0', enabled: true });
  }
  const { maintainProfile } = await import('../apps/server/src/host.js'); await maintainProfile({ dataDir: f.options.dataDir, distributionDir, profile });
  f.host = await startHost({ ...f.options, port, distributionDir }); cleanup.push(() => f.host.close()); f.bootstrap = await (await fetch(`${f.host.url}/api/bootstrap`, { headers: { Cookie: f.session } })).json(); expect(f.bootstrap.diagnostics).toEqual([]);
  expect((await command(f, 'fixture.dotted.add', null)).status).toBe(200);
  expect(await (await query(f.host.url, f.session, 'fixture.dotted')).json()).toEqual([{ value: 'notes.example' }]);
  expect(await (await query(f.host.url, f.session, 'fixture.hyphenated')).json()).toEqual([]);
  expect((await command(f, 'fixture.hyphenated.add', null)).status).toBe(200);
  expect(await (await query(f.host.url, f.session, 'fixture.hyphenated')).json()).toEqual([{ value: 'notes-example' }]);
});

test('a shorter Plugin ID cannot accidentally bind reads to a dotted descendant owner table', async () => {
  const { cp, mkdir, writeFile } = await import('node:fs/promises'); const f = await fixture(); await f.host.close();
  const distributionDir = join(f.directory, 'distribution'); await cp('dist', distributionDir, { recursive: true }); const profile = structuredClone(f.bootstrap.profile);
  for (const id of ['notes.example', 'notes']) {
    const directory = join(distributionDir, 'plugins', id, '0.1.0'); await mkdir(directory, { recursive: true });
    const ownTable = `${repositoryNamespace(id)}items`; const referencedTable = `${repositoryNamespace('notes.example')}items`;
    await writeFile(join(directory, 'aork.plugin.json'), JSON.stringify({ manifestVersion: 1, id, version: '0.1.0', sdkRange: '^0.1.0', server: 'server.js', ui: { providers: [] } }));
    await writeFile(join(directory, 'server.js'), `export const persistence={namespace:${JSON.stringify(repositoryNamespace(id))},migrations:[{version:1,statements:['CREATE TABLE ${ownTable} (value TEXT PRIMARY KEY)']}],statements:{read:{sql:'SELECT value FROM ${referencedTable}',mode:'read'}}}; export function activate(context){context.query('fixture.${id}',{access:'authenticated',execute:()=>context.repository.all('read')})}`);
    profile.plugins.push({ id, version: '0.1.0', enabled: true });
  }
  const { maintainProfile } = await import('../apps/server/src/host.js'); await maintainProfile({ dataDir: f.options.dataDir, distributionDir, profile });
  f.host = await startHost({ ...f.options, distributionDir }); cleanup.push(() => f.host.close());
  const bootstrap = await (await fetch(`${f.host.url}/api/bootstrap`)).json(); expect(bootstrap.access.state).toBe('unavailable'); expect(bootstrap.diagnostics).toContainEqual(expect.objectContaining({ code: 'PLUGIN_ACTIVATION_FAILED', pluginId: 'notes' }));
});
