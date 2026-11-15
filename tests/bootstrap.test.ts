import { afterEach, expect, test } from 'vitest';
import { mkdtemp, rm, cp, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHost } from '../apps/server/src/host.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

test('first boot serves real plugin contributions and refuses protected queries without the local token access link', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'aork-bootstrap-'));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const host = await startHost({ dataDir, port: 0 });
  cleanup.push(() => host.close());
  const response = await fetch(`${host.url}/api/bootstrap`);
  expect(response.status).toBe(200);
  const boot = await response.json();
  expect(boot).toMatchObject({ apiVersion: 1, access: { state: 'unauthenticated' }, profile: { id: 'personal-server' } });
  expect(boot.ui.providers['aork.auth.login@1']).toBe('auth-single-user:login');
  expect(boot.plugins.map((plugin: { id: string }) => plugin.id)).toEqual(['auth-single-user', 'workbench']);
  const client = boot.plugins.find((plugin: { id: string }) => plugin.id === 'auth-single-user').client;
  expect(client).toMatch(/^\/plugins\/[a-f0-9]{64}\/client\.js$/);
  expect((await fetch(`${host.url}${client}`)).status).toBe(200);
  expect((await fetch(`${host.url}${client.replace('client.js', 'server.js')}`)).status).toBe(404);
  expect(await (await fetch(`${host.url}/api/queries/auth.status`)).json()).toEqual({ state: 'unauthenticated' });
  const protectedResponse = await fetch(`${host.url}/api/queries/workbench.overview`);
  expect(protectedResponse.status).toBe(401);
  expect(await protectedResponse.json()).toMatchObject({ error: { code: 'AUTHENTICATION_REQUIRED' } });
  const command = await fetch(`${host.url}/api/commands/workbench.open`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: host.url, Cookie: 'aork_session=untrusted' }, body: '{}' });
  expect(command.status).toBe(401);
  expect(await command.json()).toMatchObject({ error: { code: 'AUTHENTICATION_REQUIRED' } });
});

test('local maintenance preserves the exact profile and startup configuration across Host restarts', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'aork-persist-'));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const first = await startHost({ dataDir, port: 0 });
  cleanup.push(() => first.close());
  const before = await (await fetch(`${first.url}/api/bootstrap`)).json();
  await first.close();
  const { maintainProfile } = await import('../apps/server/src/host.js');
  const selected = { ...before.profile, id: 'personal-test' };
  const maintenance = await maintainProfile({ dataDir, profile: selected });
  expect(maintenance).toMatchObject({ startup: { version: 1, host: '127.0.0.1', port: 0 }, profile: { id: 'personal-test' } });
  const second = await startHost({ dataDir });
  cleanup.push(() => second.close());
  const after = await (await fetch(`${second.url}/api/bootstrap`)).json();
  expect(after.profile).toEqual(selected);
  expect(after.hostEpoch).not.toBe(before.hostEpoch);
  expect(after.plugins.map((plugin: { id: string; version: string }) => `${plugin.id}@${plugin.version}`)).toEqual(['auth-single-user@0.1.0', 'workbench@0.1.0']);
});

test('a second Host and local maintenance cannot write a live data instance; the first Host stays available', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'aork-locked-'));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const first = await startHost({ dataDir, port: 0 });
  cleanup.push(() => first.close());
  await expect(startHost({ dataDir, port: 0 })).rejects.toMatchObject({ code: 'ELOCKED' });
  const { maintainProfile } = await import('../apps/server/src/host.js');
  await expect(maintainProfile({ dataDir })).rejects.toMatchObject({ code: 'ELOCKED' });
  expect((await fetch(`${first.url}/api/bootstrap`)).status).toBe(200);
  await first.close();
  const replacement = await startHost({ dataDir });
  cleanup.push(() => replacement.close());
  expect((await fetch(`${replacement.url}/api/bootstrap`)).status).toBe(200);
});

async function distributionFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'aork-distribution-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const distributionDir = join(directory, 'dist');
  await cp('dist', distributionDir, { recursive: true });
  return { directory, distributionDir, dataDir: join(directory, 'data') };
}

test('failed activation releases registrations and the disposer returned by an otherwise real plugin', async () => {
  const fixture = await distributionFixture();
  const packageDir = join(fixture.distributionDir, 'plugins/auth-single-user/0.1.0');
  const manifestPath = join(packageDir, 'aork.plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.provides.push('aork.missing@1');
  await writeFile(manifestPath, JSON.stringify(manifest));
  const released = join(fixture.directory, 'plugin-resource-released');
  const serverPath = join(packageDir, 'server.js');
  const server = await readFile(serverPath, 'utf8');
  await writeFile(serverPath, `import { writeFileSync } from 'node:fs';\n${server.replace('\n}\nexport {', `\nreturn () => writeFileSync(${JSON.stringify(released)}, 'released');\n}\nexport {`)}`);
  const host = await startHost({ ...fixture, port: 0 });
  cleanup.push(() => host.close());
  const boot = await (await fetch(`${host.url}/api/bootstrap`)).json();
  expect(boot.diagnostics).toContainEqual(expect.objectContaining({ code: 'PLUGIN_ACTIVATION_FAILED' }));
  const query = await fetch(`${host.url}/api/queries/auth.status`);
  expect(query.status).toBe(503);
  expect(await query.json()).toMatchObject({ error: { code: 'AUTH_UNAVAILABLE' } });
  expect(await readFile(released, 'utf8')).toBe('released');
});

test('static SDK incompatibility is rejected before importing any server entry', async () => {
  const fixture = await distributionFixture();
  const packageDir = join(fixture.distributionDir, 'plugins/auth-single-user/0.1.0');
  const manifestPath = join(packageDir, 'aork.plugin.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.sdkRange = '^9.0.0';
  await writeFile(manifestPath, JSON.stringify(manifest));
  const executed = join(fixture.directory, 'must-not-execute');
  const serverPath = join(packageDir, 'server.js');
  await writeFile(serverPath, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(executed)}, 'executed');\n${await readFile(serverPath, 'utf8')}`);
  await expect(startHost({ ...fixture, port: 0 })).rejects.toMatchObject({ code: 'SDK_INCOMPATIBLE' });
  await expect(access(executed)).rejects.toMatchObject({ code: 'ENOENT' });
  // A failed startup also releases the instance lock for local repair.
  const { maintainProfile } = await import('../apps/server/src/host.js');
  await expect(maintainProfile(fixture)).rejects.toMatchObject({ code: 'SDK_INCOMPATIBLE' });
});

test('a missing authentication capability refuses business access and reports the selected login provider fault', async () => {
  const fixture = await distributionFixture();
  const path = join(fixture.distributionDir, 'profiles/personal-server.json');
  const profile = JSON.parse(await readFile(path, 'utf8'));
  profile.plugins[0].enabled = false;
  await writeFile(path, JSON.stringify(profile));
  const host = await startHost({ ...fixture, port: 0 });
  cleanup.push(() => host.close());
  const boot = await (await fetch(`${host.url}/api/bootstrap`)).json();
  expect(boot.access.state).toBe('unavailable');
  expect(boot.diagnostics).toContainEqual(expect.objectContaining({ code: 'UI_PROVIDER_UNAVAILABLE', location: 'ui.providers.aork.auth.login@1' }));
  const query = await fetch(`${host.url}/api/queries/workbench.overview`);
  expect(query.status).toBe(503);
  expect(await query.json()).toMatchObject({ error: { code: 'AUTH_UNAVAILABLE' } });
});

test('local profile preflight refuses a missing selected provider without replacing the persisted profile', async () => {
  const fixture = await distributionFixture();
  const first = await startHost({ ...fixture, port: 0 });
  cleanup.push(() => first.close());
  const original = await (await fetch(`${first.url}/api/bootstrap`)).json();
  await first.close();
  const invalid = structuredClone(original.profile);
  invalid.ui.providers['aork.workbench.layout@1'] = 'workbench:absent';
  const { maintainProfile } = await import('../apps/server/src/host.js');
  await expect(maintainProfile({ ...fixture, profile: invalid })).rejects.toThrow('ui.providers.aork.workbench.layout@1');
  const second = await startHost(fixture);
  cleanup.push(() => second.close());
  const after = await (await fetch(`${second.url}/api/bootstrap`)).json();
  expect(after.profile).toEqual(original.profile);
  expect(after.pluginGraphHash).toBe(original.pluginGraphHash);
});

test('noncanonical package entry paths are rejected during static preflight', async () => {
  const fixture = await distributionFixture();
  const path = join(fixture.distributionDir, 'plugins/auth-single-user/0.1.0/aork.plugin.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.client = './client.js';
  await writeFile(path, JSON.stringify(manifest));
  await expect(startHost({ ...fixture, port: 0 })).rejects.toThrow(/canonical|relative package path/);
});

test('public startup diagnostics identify a faulty plugin without exposing its exception payload', async () => {
  const fixture = await distributionFixture();
  const path = join(fixture.distributionDir, 'plugins/workbench/0.1.0/server.js');
  await writeFile(path, `throw new Error('server-private-value');\n${await readFile(path, 'utf8')}`);
  const host = await startHost({ ...fixture, port: 0 });
  cleanup.push(() => host.close());
  const boot = await (await fetch(`${host.url}/api/bootstrap`)).json();
  expect(boot.diagnostics).toContainEqual(expect.objectContaining({ code: 'PLUGIN_ACTIVATION_FAILED', pluginId: 'workbench' }));
  expect(JSON.stringify(boot)).not.toContain('server-private-value');
  expect((await fetch(`${host.url}/api/queries/auth.status`)).status).toBe(503);
});
