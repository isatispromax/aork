import { afterEach, expect, test } from 'vitest';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
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

test('a real server directory becomes a persistent Workspace through an authenticated durable command', async () => {
  const f = await fixture();
  const response = await command(f, 'workspace.create', { workspace: { name: 'Notes', directory: f.external } });
  expect(response.status).toBe(200);
  const receipt = await response.json();
  expect(receipt).toMatchObject({ name: 'workspace.create', version: 1, outcome: 'completed', result: { name: 'Notes', directory: await realpath(f.external), createdAt: expect.any(String) } });
  expect(receipt.events).toHaveLength(1); expect(receipt.events[0].seq).toMatch(/^[1-9][0-9]*$/);
  const initial = await (await query(f.host.url, f.session)).json(); expect(initial).toEqual({ workspaces: [receipt.result] });
  await f.host.close();
  const restarted = await startHost({ ...f.options, port: Number(new URL(f.host.url).port) }); cleanup.push(() => restarted.close());
  expect(await (await query(restarted.url, f.session)).json()).toEqual(initial);
});

test('canonical wire retries return the immutable receipt before touching the directory and reject changed command content', async () => {
  const f = await fixture(); const commandId = crypto.randomUUID();
  const payload = { workspace: { name: 'Notes', directory: f.external } };
  const first = await command(f, 'workspace.create', payload, commandId); expect(first.status).toBe(200); const saved = await first.json();
  const concurrent = await Promise.all([command(f, 'workspace.create', { workspace: payload.workspace }, commandId), command(f, 'workspace.create', payload, commandId)]);
  for (const response of concurrent) expect(await response.json()).toEqual(saved);
  expect((await (await query(f.host.url, f.session)).json()).workspaces).toHaveLength(1);
  const changed = await command(f, 'workspace.create', { workspace: { ...payload.workspace, name: 'Research' } }, commandId); expect(changed.status).toBe(409); expect(await changed.json()).toMatchObject({ error: { code: 'COMMAND_ID_CONFLICT' } });
  await rm(f.external, { recursive: true });
  expect(await (await command(f, 'workspace.create', payload, commandId)).json()).toEqual(saved);
  const lookup = await fetch(`${f.host.url}/api/receipts/${commandId}`, { headers: { Cookie: f.session } }); expect(await lookup.json()).toEqual(saved);
  const events = await (await fetch(`${f.host.url}/api/events?after=0&limit=1`, { headers: { Cookie: f.session } })).json();
  expect(events.events).toHaveLength(1); expect(events.events[0]).toMatchObject({ ...saved.events[0], owner: 'workspace', type: 'workspace.created', visibility: 'browser', commandId });
  expect(JSON.stringify(events)).not.toContain('csrf'); expect(JSON.stringify(events)).not.toContain(f.bootstrap.access.identity);
});

test('directory and schema rejection leave no visible entity, receipt or event and the corrected command can reuse its ID', async () => {
  const f = await fixture(); const commandId = crypto.randomUUID();
  const invalid = await command(f, 'workspace.create', { workspace: { name: 'Missing', directory: join(f.directory, 'absent') } }, commandId);
  expect(invalid.status).toBe(400); expect(await invalid.json()).toMatchObject({ error: { code: 'WORKSPACE_DIRECTORY_INVALID' } });
  // Managed auto-creation no longer exists: the input contract has no management field,
  // so a managed-style payload fails schema validation before any directory is touched.
  const unsupported = await command(f, 'workspace.create', { workspace: { name: 'Auto', management: 'managed' } }, commandId); expect(unsupported.status).toBe(400); expect((await unsupported.json()).error.code).toBe('INVALID_PAYLOAD');
  const unexpected = await command(f, 'workspace.create', { workspace: { name: 'Missing', directory: join(f.directory, 'absent') }, credential: 'do-not-store' }, commandId); expect(unexpected.status).toBe(400);
  expect(await (await query(f.host.url, f.session)).json()).toEqual({ workspaces: [] });
  expect((await fetch(`${f.host.url}/api/receipts/${commandId}`, { headers: { Cookie: f.session } })).status).toBe(404);
  expect(await (await fetch(`${f.host.url}/api/events`, { headers: { Cookie: f.session } })).json()).toEqual({ events: [] });
  const corrected = await command(f, 'workspace.create', { workspace: { name: 'Valid', directory: f.external } }, commandId); expect(corrected.status).toBe(200);
  const saved = await corrected.json(); expect(saved.result.scope.root).toBe(saved.result.directory);
});

test('a Workspace renames to a name no other Workspace holds, an unchanged name writes nothing, and archiving is gone', async () => {
  const f = await fixture();
  const created = await (await command(f, 'workspace.create', { workspace: { name: 'Notes', directory: f.external } })).json();
  const workspace = created.result;
  const drafts = join(f.directory, 'drafts'); await mkdir(drafts, { recursive: true });
  const second = await (await command(f, 'workspace.create', { workspace: { name: 'Drafts', directory: drafts } })).json();
  expect(second.result.directory).toBe(await realpath(join(f.directory, 'drafts')));
  const renamed = await command(f, 'workspace.rename', { id: workspace.id, name: 'Renamed notes' }); expect(renamed.status).toBe(200);
  const receipt = await renamed.json();
  expect(receipt.result).toMatchObject({ id: workspace.id, name: 'Renamed notes', directory: workspace.directory, createdAt: workspace.createdAt });
  expect(receipt.events).toHaveLength(1);
  // A name another Workspace holds is refused, surrounding space included: the comparison is on the trimmed name.
  for (const name of ['Drafts', ' Drafts ']) {
    const conflict = await command(f, 'workspace.rename', { id: workspace.id, name });
    expect(conflict.status).toBe(409); expect(await conflict.json()).toMatchObject({ error: { code: 'WORKSPACE_NAME_CONFLICT' } });
  }
  // An unchanged name is a confirmed no-op: the record comes back and no event leaves.
  const unchanged = await command(f, 'workspace.rename', { id: workspace.id, name: 'Renamed notes' }); expect(unchanged.status).toBe(200);
  expect((await unchanged.json()).events).toHaveLength(0);
  expect((await command(f, 'workspace.rename', { id: crypto.randomUUID(), name: 'Missing' })).status).toBe(409);
  // The archived state left with its command.
  const archived = await command(f, 'workspace.archive', { id: second.result.id });
  expect(archived.status).toBe(404); expect(await archived.json()).toMatchObject({ error: { code: 'COMMAND_NOT_FOUND' } });
  const overview = await (await query(f.host.url, f.session)).json();
  expect(overview.workspaces.map((item: { name: string }) => item.name)).toEqual(['Renamed notes', 'Drafts']);
  expect(await realpath(second.result.directory)).toBe(second.result.directory); expect(await realpath(f.external)).toBe(workspace.directory);
});
test('a malformed Plugin result rolls back the Workspace, receipt and durable event together, and a repaired package can retry', async () => {
  const { cp, readFile, writeFile } = await import('node:fs/promises');
  const f = await fixture(); await f.host.close();
  const distributionDir = join(f.directory, 'distribution'); await cp('dist', distributionDir, { recursive: true });
  const server = join(distributionDir, 'plugins/workspace/0.1.0/server.js'); const original = await readFile(server, 'utf8');
  const changed = original.replace('result: workspace, events', 'result: { ...workspace, status: "invalid" }, events'); expect(changed).not.toBe(original); await writeFile(server, changed);
  f.host = await startHost({ ...f.options, port: Number(new URL(f.host.url).port), distributionDir }); cleanup.push(() => f.host.close());
  f.bootstrap = await (await fetch(`${f.host.url}/api/bootstrap`, { headers: { Cookie: f.session } })).json();
  const commandId = crypto.randomUUID(); const payload = { workspace: { name: 'Actual', directory: f.external } };
  const rejected = await command(f, 'workspace.create', payload, commandId); expect(rejected.status).toBe(500); expect(await rejected.json()).toMatchObject({ error: { code: 'INVALID_COMMAND_RESULT' } });
  expect(await (await query(f.host.url, f.session)).json()).toEqual({ workspaces: [] });
  expect((await fetch(`${f.host.url}/api/receipts/${commandId}`, { headers: { Cookie: f.session } })).status).toBe(404);
  expect(await (await fetch(`${f.host.url}/api/events`, { headers: { Cookie: f.session } })).json()).toEqual({ events: [] });
  await f.host.close(); await writeFile(server, original);
  f.host = await startHost({ ...f.options, port: Number(new URL(f.host.url).port), distributionDir }); cleanup.push(() => f.host.close());
  f.bootstrap = await (await fetch(`${f.host.url}/api/bootstrap`, { headers: { Cookie: f.session } })).json();
  expect((await command(f, 'workspace.create', payload, commandId)).status).toBe(200);
});

test('receipt identity and ordered bounded decimal event cursors survive local signing-key recovery', async () => {
  const { maintainAccess } = await import('../apps/server/src/host.js');
  const f = await fixture(); const commandId = crypto.randomUUID();
  const payload = { workspace: { name: 'Local', directory: f.external } };
  const original = await command(f, 'workspace.create', payload, commandId); const originalText = await original.text(); const saved = JSON.parse(originalText);
  const edited = await command(f, 'workspace.rename', { id: saved.result.id, name: 'Edited' }); expect(edited.status).toBe(200);
  const differentName = await command(f, 'workspace.create', { workspace: { ...payload.workspace, name: 'Renamed' } }, commandId); expect(differentName.status).toBe(409);
  const wrongVersion = await fetch(`${f.host.url}/api/commands/workspace.create`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: f.host.url, Cookie: f.session, 'X-Aork-CSRF': f.bootstrap.access.csrfToken! }, body: JSON.stringify({ apiVersion: 1, commandVersion: 2, commandId, pluginGraphHash: f.bootstrap.pluginGraphHash, payload }) });
  expect(await wrongVersion.json()).toMatchObject({ error: { code: 'COMMAND_ID_CONFLICT' } });
  const first = await (await fetch(`${f.host.url}/api/events?limit=1`, { headers: { Cookie: f.session } })).json(); const next = await (await fetch(`${f.host.url}/api/events?after=${first.events[0].seq}&limit=1`, { headers: { Cookie: f.session } })).json();
  expect(first.events[0].seq).toBe(saved.events[0].seq); expect(BigInt(next.events[0].seq)).toBeGreaterThan(BigInt(first.events[0].seq));
  for (const cursor of ['01', '-1', '1e2', '9223372036854775808', '9007199254740993.0']) expect((await fetch(`${f.host.url}/api/events?after=${cursor}`, { headers: { Cookie: f.session } })).status).toBe(400);
  // Decimal syntax is lossless, but a cursor beyond the saved event head now
  // explicitly requires a new snapshot rather than silently skipping history.
  expect((await fetch(`${f.host.url}/api/events?after=9007199254740993`, { headers: { Cookie: f.session } })).status).toBe(409);
  expect((await fetch(`${f.host.url}/api/events?limit=101`, { headers: { Cookie: f.session } })).status).toBe(400);
  expect((await fetch(`${f.host.url}/api/events`)).status).toBe(401); expect((await fetch(`${f.host.url}/api/receipts/${commandId}`)).status).toBe(401);
  const identity = f.bootstrap.access.identity; const port = Number(new URL(f.host.url).port); await f.host.close(); await maintainAccess({ dataDir: f.options.dataDir, action: 'recover' });
  f.host = await startHost({ ...f.options, port }); cleanup.push(() => f.host.close());
  expect((await query(f.host.url, f.session)).status).toBe(401);
  const exchange = await fetch(f.host.accessUrl!, { redirect: 'manual' }); f.session = exchange.headers.get('set-cookie')!.split(';')[0]!;
  f.bootstrap = await (await fetch(`${f.host.url}/api/bootstrap`, { headers: { Cookie: f.session } })).json(); expect(f.bootstrap.access.identity).toBe(identity);
  expect(await (await command(f, 'workspace.create', payload, commandId)).text()).toBe(originalText);
  expect((await (await query(f.host.url, f.session)).json()).workspaces[0].name).toBe('Edited');
  expect(await (await fetch(`${f.host.url}/api/events?limit=1`, { headers: { Cookie: f.session } })).json()).toEqual(first);
});

test('one registration per canonical directory: an alias resolves to the same Workspace, named after its requested directory', async () => {
  const { symlink, writeFile, rename } = await import('node:fs/promises');
  const f = await fixture(); const alias = join(f.directory, 'alias'); await symlink(f.external, alias);
  // Without a name the Workspace takes its requested directory's last segment, so an alias keeps its own spelling.
  const created = await command(f, 'workspace.create', { workspace: { directory: alias } }); expect(created.status).toBe(200);
  const saved = (await created.json()).result;
  expect(saved).toMatchObject({ name: 'alias', requestedDirectory: alias, directory: await realpath(f.external), scope: { root: await realpath(f.external), recursive: true } });
  // Requesting that directory again, by its real path, returns the registration: nothing is added or announced.
  const again = await command(f, 'workspace.create', { workspace: { name: 'Same actual directory', directory: f.external } }); expect(again.status).toBe(200);
  const replay = await again.json(); expect(replay.result).toEqual(saved); expect(replay.events).toHaveLength(0);
  const events = await (await fetch(`${f.host.url}/api/events?after=0&limit=100`, { headers: { Cookie: f.session } })).json();
  expect(events.events.map((event: { type: string }) => event.type)).toEqual(['workspace.created']);
  const file = join(f.directory, 'file'); await writeFile(file, 'not a directory');
  for (const directory of [file, 'relative', join(f.directory, 'missing')]) expect((await command(f, 'workspace.create', { workspace: { directory } })).status).toBe(400);
  // Renaming is a title change only: a directory that moved since registration does not block it.
  await rename(f.external, `${f.external}-moved`);
  const renamed = await command(f, 'workspace.rename', { id: saved.id, name: 'Changed' }); expect(renamed.status).toBe(200);
  const overview = await (await query(f.host.url, f.session)).json(); expect(overview.workspaces).toHaveLength(1); expect(overview.workspaces[0].name).toBe('Changed');
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
    // Each needs its own directory: one registration per canonical directory.
    const research = join(f.directory, `research-${index}`); await mkdir(research, { recursive: true });
    const commandId = crypto.randomUUID(); const payload = { workspace: { name: `Research ${index}`, directory: research } };
    const response = await command(f, 'workspace.create', payload, commandId);
    if (response.status === 200) accepted.push(await response.json());
    else { expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ error: { code: 'STORAGE_UNAVAILABLE' } }); failedId = commandId; failedPayload = payload; break; }
  }
  expect(failedId).not.toBe(''); expect(accepted.length).toBeGreaterThan(0);
  const overview = await (await query(f.host.url, f.session)).json(); expect(overview.workspaces).toHaveLength(accepted.length);
  const events = await (await fetch(`${f.host.url}/api/events`, { headers: { Cookie: f.session } })).json(); expect(events.events).toHaveLength(accepted.length);
  expect((await fetch(`${f.host.url}/api/receipts/${failedId}`, { headers: { Cookie: f.session } })).status).toBe(404);
  expect((await command(f, 'workspace.create', failedPayload, failedId)).status).toBe(503);
  child.kill('SIGTERM'); await done;
  f.host = await startHost({ ...f.options, port }); cleanup.push(() => f.host.close());
  f.bootstrap = await (await fetch(`${f.host.url}/api/bootstrap`, { headers: { Cookie: f.session } })).json();
  expect(await (await query(f.host.url, f.session)).json()).toEqual(overview);
  expect((await command(f, 'workspace.create', failedPayload, failedId)).status).toBe(200);
});

test('a fresh data directory builds its schema while an old-checksum database refuses activation with guidance to clear it', async () => {
  const f = await fixture();
  const created = await command(f, 'workspace.create', { workspace: { name: 'Notes', directory: f.external } });
  expect(created.status).toBe(200);
  expect((await (await query(f.host.url, f.session)).json()).workspaces).toHaveLength(1);
  await f.host.close();

  // A data directory written by the previous release: legacy workspace schema plus
  // its recorded migration checksums. The rewritten declarations must refuse it.
  const stale = await mkdtemp(join(tmpdir(), 'aork-stale-schema-')); cleanup.push(() => rm(stale, { recursive: true, force: true }));
  const dataDir = join(stale, 'data'); await mkdir(dataDir, { recursive: true });
  const sqlite = new Database(join(dataDir, 'aork.sqlite'));
  sqlite.exec('CREATE TABLE host_migrations (owner TEXT NOT NULL, version INTEGER NOT NULL, checksum TEXT NOT NULL, PRIMARY KEY(owner, version))');
  sqlite.exec('CREATE TABLE IF NOT EXISTS plugin_state (plugin TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (plugin, key))');
  sqlite.prepare('INSERT INTO plugin_state (plugin, key, value) VALUES (?,?,?)').run('@host/lifecycle', 'selectedVersions', JSON.stringify({ workspace: '0.1.0' }));
  const legacyMigrations = [
    ["CREATE TABLE plugin_workspace__projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','archived')))", 'CREATE TABLE plugin_workspace__workspaces (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES plugin_workspace__projects(id), record TEXT NOT NULL)', 'CREATE INDEX plugin_workspace__project_id ON plugin_workspace__workspaces(project_id)'],
    ['CREATE TABLE plugin_workspace__claims (run_id TEXT PRIMARY KEY, record TEXT NOT NULL)'],
  ] as const;
  for (const [version, statements] of legacyMigrations.entries()) sqlite.prepare('INSERT INTO host_migrations (owner,version,checksum) VALUES (?,?,?)').run('workspace', version + 1, createHash('sha256').update(JSON.stringify(statements)).digest('hex'));
  sqlite.exec(legacyMigrations[0].join('; ')); sqlite.exec(legacyMigrations[1][0]!);
  sqlite.close();
  const staleHost = await startHost({ dataDir, port: 0, insecureLoopback: true }); cleanup.push(() => staleHost.close());
  const bootstrap = await (await fetch(`${staleHost.url}/api/bootstrap`)).json() as Bootstrap;
  expect(bootstrap.access.state).toBe('unavailable');
  expect(bootstrap.diagnostics).toContainEqual(expect.objectContaining({ code: 'PLUGIN_ACTIVATION_FAILED', pluginId: 'workspace' }));
  expect((await query(staleHost.url, 'no-session', 'workspace.overview')).status).toBe(503);
  expect(JSON.stringify(bootstrap)).not.toContain('corrupt');
});

test('a Plugin cannot register a mutating RETURNING statement as a transaction-free read', async () => {
  const { cp, mkdir, writeFile } = await import('node:fs/promises');
  const f = await fixture(); await f.host.close(); f.options.dataDir=join(f.directory,'initial-package-data');
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
  const changed = original.replace('execute(payload, prepared, transaction) {', 'async execute(_payload, _prepared, transaction) { throw new Error("private-async-fault");'); expect(changed).not.toBe(original); await writeFile(server, changed);
  const child = spawn(process.execPath, ['dist/server/main.mjs', '--data-dir', f.options.dataDir, '--distribution-dir', distributionDir, '--port', String(port), '--insecure-loopback']);
  const done = new Promise<void>(resolve => child.once('exit', () => resolve())); cleanup.push(async () => { child.kill('SIGTERM'); await done; });
  await new Promise<void>((resolve, reject) => { let output = ''; let stderr = ''; child.stdout.on('data', chunk => { output += String(chunk); if (output.includes('host.listening')) resolve(); }); child.stderr.on('data', chunk => { stderr += String(chunk); }); child.once('error', reject); child.once('exit', code => reject(new Error(`Host exited ${code}: ${stderr}`))); });
  f.bootstrap = await (await fetch(`${f.host.url}/api/bootstrap`, { headers: { Cookie: f.session } })).json();
  const commandId = crypto.randomUUID(); const response = await command(f, 'workspace.create', { workspace: { name: 'Actual', directory: f.external } }, commandId);
  expect(response.status).toBe(500); expect(await response.json()).toMatchObject({ error: { code: 'TRANSACTION_ASYNC' } });
  expect(await (await query(f.host.url, f.session)).json()).toEqual({ workspaces: [] });
  expect((await fetch(`${f.host.url}/api/receipts/${commandId}`, { headers: { Cookie: f.session } })).status).toBe(404);
  expect(await (await fetch(`${f.host.url}/api/events`, { headers: { Cookie: f.session } })).json()).toEqual({ events: [] });
});

test('valid dotted and hyphenated installed Plugin IDs own distinct repository namespaces', async () => {
  const { cp, mkdir, writeFile } = await import('node:fs/promises');
  const f = await fixture(); const port = Number(new URL(f.host.url).port); await f.host.close(); f.options.dataDir=join(f.directory,'initial-package-data');
  const distributionDir = join(f.directory, 'distribution'); await cp('dist', distributionDir, { recursive: true }); const profile = structuredClone(f.bootstrap.profile);
  for (const [id, queryName] of [['notes.example', 'fixture.dotted'], ['notes-example', 'fixture.hyphenated']] as const) {
    const directory = join(distributionDir, 'plugins', id, '0.1.0'); await mkdir(directory, { recursive: true });
    const table = `${repositoryNamespace(id)}items`;
    await writeFile(join(directory, 'aork.plugin.json'), JSON.stringify({ manifestVersion: 1, id, version: '0.1.0', sdkRange: '^0.1.0', server: 'server.js', ui: { providers: [] } }));
    await writeFile(join(directory, 'server.js'), `export const persistence = { namespace:${JSON.stringify(repositoryNamespace(id))}, migrations:[{version:1,statements:['CREATE TABLE ${table} (value TEXT PRIMARY KEY)']}], statements:{read:{sql:'SELECT value FROM ${table}',mode:'read'},write:{sql:'INSERT INTO ${table} (value) VALUES (?)',mode:'write'}} }; export function activate(context) { context.query('${queryName}',{access:'authenticated',execute:()=>context.repository.all('read')}); context.durableCommand('${queryName}.add',{version:1,payload:{parse(value){if(value!==null)throw Error('invalid');return null}},result:{parse(value){if(value!=='saved')throw Error('invalid');return value}},events:{},execute(_payload,_prepared,tx){context.repository.run(tx,'write',['${id}']);return{result:'saved',events:[]}}}); }`);
    profile.plugins.push({ id, version: '0.1.0', enabled: true });
  }
  const { maintainProfile } = await import('../apps/server/src/host.js'); await maintainProfile({ dataDir: f.options.dataDir, distributionDir, profile });
  f.host = await startHost({ ...f.options, port, distributionDir }); cleanup.push(() => f.host.close());const login=await fetch(f.host.accessUrl!,{redirect:'manual'});f.session=login.headers.get('set-cookie')!.split(';')[0]!; f.bootstrap = await (await fetch(`${f.host.url}/api/bootstrap`, { headers: { Cookie: f.session } })).json(); expect(f.bootstrap.diagnostics).toEqual([]);
  expect((await command(f, 'fixture.dotted.add', null)).status).toBe(200);
  expect(await (await query(f.host.url, f.session, 'fixture.dotted')).json()).toEqual([{ value: 'notes.example' }]);
  expect(await (await query(f.host.url, f.session, 'fixture.hyphenated')).json()).toEqual([]);
  expect((await command(f, 'fixture.hyphenated.add', null)).status).toBe(200);
  expect(await (await query(f.host.url, f.session, 'fixture.hyphenated')).json()).toEqual([{ value: 'notes-example' }]);
});

test('a shorter Plugin ID cannot accidentally bind reads to a dotted descendant owner table', async () => {
  const { cp, mkdir, writeFile } = await import('node:fs/promises'); const f = await fixture(); await f.host.close(); f.options.dataDir=join(f.directory,'initial-package-data');
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
