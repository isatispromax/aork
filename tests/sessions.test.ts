import { afterEach, expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { sessionEnvironment, sessionHost } from './fixtures/session-host.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

test('Session creation persists its own stable identity and environment without starting a Run', async () => {
  const f = await sessionHost(); cleanup.push(() => f.close()); const environment = await sessionEnvironment(f);
  const response = await f.command('sessions.create', environment.input); expect(response.status).toBe(200);
  const receipt = await response.json();
  expect(JSON.stringify(receipt)).not.toContain('stateDirectory');
  expect(receipt.result).toMatchObject({ name: 'Research conversation', status: 'open', projectId: environment.project.id, workspaceId: environment.workspace.id, profileId: environment.profile.id, profile: { revision: 1, providerId: 'session.test', parameters: { model: 'controlled-model' } }, workspace: { directory: environment.workspace.directory } });
  expect([environment.project.id, environment.workspace.id, environment.profile.id]).not.toContain(receipt.result.id);
  const overview = await f.query(); expect(overview.status).toBe(200);
  expect(await overview.json()).toMatchObject({ sessions: [{ session: receipt.result, environment: { status: 'open', directory: { status: 'available' } }, execution: { state: 'not-started' }, nativeHistory: { restorable: false, reason: 'never-started' } }] });
  await f.restart(); expect(await (await f.query()).json()).toMatchObject({ sessions: [{ session: receipt.result }] });
});

test('identical concurrent Session commands keep one receipt and configuration selection across Profile edits and restart', async () => {
  const f = await sessionHost(); cleanup.push(() => f.close()); const environment = await sessionEnvironment(f); const commandId = crypto.randomUUID();
  const responses = await Promise.all([f.command('sessions.create', environment.input, commandId), f.command('sessions.create', environment.input, commandId)]);
  expect(responses.map(response => response.status)).toEqual([200, 200]); const receipt = await responses[0]!.json(); expect(await responses[1]!.json()).toEqual(receipt);
  const changed = await f.command('sessions.create', { ...environment.input, name: 'Different' }, commandId); expect(changed.status).toBe(409); expect(await changed.json()).toMatchObject({ error: { code: 'COMMAND_ID_CONFLICT' } });
  const { id, revision, stateDirectory: _directory, ...input } = environment.profile;
  expect((await f.command('agents.editProfile', { ...input, id, expectedRevision: revision, parameters: { model: 'changed-model' } })).status).toBe(200);
  expect((await (await f.query()).json()).sessions).toHaveLength(1);
  expect(await (await f.query()).json()).toMatchObject({ sessions: [{ session: { profile: { parameters: { model: 'controlled-model' }, revision: 1 } } }] });
  await rm(environment.workspace.directory, { recursive: true }); await f.restart();
  expect(await (await f.command('sessions.create', environment.input, commandId)).json()).toEqual(receipt);
  expect(await (await fetch(`${f.host.url}/api/receipts/${commandId}`, { headers: { Cookie: f.cookie } })).json()).toEqual(receipt);
});

test('invalid cross references and archived environments cannot create Sessions or leave accepted receipts', async () => {
  const f = await sessionHost(); cleanup.push(() => f.close()); const environment = await sessionEnvironment(f); const commandId = crypto.randomUUID();
  for (const input of [
    { ...environment.input, projectId: crypto.randomUUID() },
    { ...environment.input, workspaceId: crypto.randomUUID() },
    { ...environment.input, profileId: crypto.randomUUID() },
    { ...environment.input, launch: { executable: '/private/command' } },
    { ...environment.input, profile: environment.profile },
  ]) expect((await f.command('sessions.create', input, commandId)).status).toBeGreaterThanOrEqual(400);
  expect(await (await f.query()).json()).toEqual({ sessions: [] });
  expect((await fetch(`${f.host.url}/api/receipts/${commandId}`, { headers: { Cookie: f.cookie } })).status).toBe(404);
  expect((await f.command('workspace.archive', { id: environment.workspace.id })).status).toBe(200);
  expect(await (await f.command('sessions.create', environment.input, commandId)).json()).toMatchObject({ error: { code: 'WORKSPACE_UNAVAILABLE' } });
  const extra = await (await f.command('workspace.create', { projectId: environment.project.id, workspace: { name: 'More notes', management: 'managed' } })).json();
  expect((await f.command('workspace.archiveProject', { id: environment.project.id })).status).toBe(200);
  expect(await (await f.command('sessions.create', { ...environment.input, workspaceId: extra.result.id }, commandId)).json()).toMatchObject({ error: { code: 'WORKSPACE_UNAVAILABLE' } });
});

test('archiving a Session retains its history and associations even after its directory disappears', async () => {
  const f = await sessionHost(); cleanup.push(() => f.close()); const environment = await sessionEnvironment(f);
  const created = await (await f.command('sessions.create', environment.input)).json(); const commandId = crypto.randomUUID();
  const archivedResponse = await f.command('sessions.archive', { id: created.result.id }, commandId); expect(archivedResponse.status).toBe(200); const archived = await archivedResponse.json();
  expect(archived.result).toEqual({ ...created.result, status: 'archived' });
  expect(await (await f.command('sessions.archive', { id: created.result.id }, commandId)).json()).toEqual(archived);
  expect(await (await f.query('workspace.overview')).json()).toMatchObject({ workspaces: [{ id: environment.workspace.id, status: 'open' }] });
  await rm(environment.workspace.directory, { recursive: true }); await f.restart();
  expect(await (await f.query()).json()).toMatchObject({ sessions: [{ session: archived.result, environment: { directory: { status: 'unavailable', reason: 'directory-unavailable' } }, nativeHistory: { restorable: false, reason: 'never-started' } }] });
  const events = await (await fetch(`${f.host.url}/api/events?after=0&limit=100`, { headers: { Cookie: f.cookie } })).json();
  expect(events.events.filter((event: { owner: string }) => event.owner === 'sessions').map((event: { type: string }) => event.type)).toEqual(['sessions.created', 'sessions.archived']);
  expect(JSON.stringify(events.events.filter((event: { owner: string }) => event.owner === 'sessions'))).not.toContain('stateDirectory');
  expect((await fetch(`${f.host.url}/api/queries/sessions.overview`)).status).toBe(401);
  const detailUrl = `${f.host.url}/api/resources/sessions.detail?id=${created.result.id}`;
  const detail = await fetch(detailUrl, { headers: { Cookie: f.cookie } }); expect(detail.status).toBe(200); expect(await detail.json()).toMatchObject({ session: archived.result });
  expect((await fetch(detailUrl)).status).toBe(401);
  expect((await fetch(`${f.host.url}/api/resources/sessions.detail?id=${crypto.randomUUID()}`, { headers: { Cookie: f.cookie } })).status).toBe(404);
  expect((await fetch(`${f.host.url}/api/resources/sessions.detail?id=invalid`, { headers: { Cookie: f.cookie } })).status).toBe(400);
});

test('a public lifecycle archive participant can refuse archival without changing Session history', async () => {
  const f = await sessionHost(); cleanup.push(() => f.close()); const environment = await sessionEnvironment(f);
  const created = await (await f.command('sessions.create', environment.input)).json(); const commandId = crypto.randomUUID();
  expect((await f.command('test.archivePolicy', { blocked: true })).status).toBe(200);
  const refused = await f.command('sessions.archive', { id: created.result.id }, commandId); expect(refused.status).toBe(409); expect(await refused.json()).toMatchObject({ error: { code: 'ARCHIVE_EXECUTION_BLOCKED' } });
  expect(await (await f.query()).json()).toMatchObject({ sessions: [{ session: { id: created.result.id, status: 'open' } }] });
  expect((await fetch(`${f.host.url}/api/receipts/${commandId}`, { headers: { Cookie: f.cookie } })).status).toBe(404);
  expect((await f.command('test.archivePolicy', { enabled: false })).status).toBe(200);
  expect(await (await f.command('sessions.archive', { id: created.result.id }, commandId)).json()).toMatchObject({ error: { code: 'SESSION_ARCHIVE_POLICY_UNAVAILABLE' } });
  expect((await f.command('test.archivePolicy', { enabled: true })).status).toBe(200);
  expect((await f.command('test.archivePolicy', { blocked: false })).status).toBe(200);
  expect((await f.command('sessions.archive', { id: created.result.id }, commandId)).status).toBe(200);
});
