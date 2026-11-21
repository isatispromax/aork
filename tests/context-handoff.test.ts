import { afterEach, expect, test } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { handoffHost, createSessionWithTurn, entry, waitFor, resource, snapshot, wire } from './fixtures/context-handoff.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() { const value = await handoffHost(); cleanup.push(() => value.f.close()); return value; }

test('createLinked creates a linked Session with two-way visible linkage while the source stays intact and retry creates nothing new', async () => {
  const { f, env, altProfile } = await fixture();
  const source = await createSessionWithTurn(f, env, 'Original question');
  await writeFile(join(env.workspace.directory, 'summary-notes.md'), 'workspace notes for the handoff');
  const artifact = (await (await f.command('artifacts.register', { workspaceId: env.workspace.id, title: 'Draft report', source: { kind: 'captured-file', workspaceId: env.workspace.id, relativePath: 'summary-notes.md' }, association: { sessionId: source.id, turnId: (await (await resource(f, 'sessions.timeline', `sessionId=${source.id}`)).json()).turns[0].id } })).json()).result;
  const payload = { sourceSessionId: source.id, name: 'Continuation on alternate agent', workspaceId: env.workspace.id, profileId: altProfile.id, carry: { summary: 'We finished the draft; continue with the alternate agent.', files: [{ workspaceId: env.workspace.id, path: 'summary-notes.md', kind: 'text' as const }], artifactVersions: [{ versionId: artifact.versionId, kind: 'text' as const }] } };
  const commandId = crypto.randomUUID();
  const response = await f.command('sessions.createLinked', payload, commandId);
  expect(response.status).toBe(200);
  const receipt = await response.json();
  const linked = receipt.result;
  expect(linked.id).not.toBe(source.id);
  expect(linked.linkedFrom).toEqual({ sessionId: source.id });
  expect(linked.profile.providerId).toBe('session.alternate');
  // Only the selected carry is recorded; the record stays pending until the user sends it.
  const handoff = (await (await snapshot(f, 'sessions.handoff', { sessionId: linked.id })).json()).snapshot.handoff;
  expect(handoff).toMatchObject({ sessionId: linked.id, sourceSessionId: source.id, state: 'pending', carry: { summary: payload.carry.summary, files: [{ path: 'summary-notes.md', kind: 'text' }], artifactVersions: [{ versionId: artifact.versionId, kind: 'text', filename: 'summary-notes.md', size: 31 }] } });
  expect(handoff.carry.artifactVersions[0].sha256).toMatch(/^[a-f0-9]{64}$/);
  // Linkage is visible from both sessions through the public overview.
  const linkedEntry = await entry(f, linked.id);
  expect(linkedEntry.session.linkedFrom).toEqual({ sessionId: source.id });
  const sourceEntry = await entry(f, source.id);
  expect(sourceEntry.linkedTo).toEqual([{ sessionId: linked.id }]);
  // The old Session keeps its inputs, timeline and artifact associations readable.
  const timeline = await (await resource(f, 'sessions.timeline', `sessionId=${source.id}`)).json();
  expect(timeline.messages.filter((message: any) => message.role === 'user').map((message: any) => message.text)).toEqual(['Original question']);
  const associated = await (await snapshot(f, 'artifacts.list', { workspaceId: env.workspace.id, sessionId: source.id })).json();
  expect(associated.snapshot.artifacts.map((item: any) => item.id)).toEqual([artifact.artifactId]);
  // Retrying the same command returns the original receipt and creates no second Session.
  expect(await (await f.command('sessions.createLinked', payload, commandId)).json()).toEqual(receipt);
  const conflict = await f.command('sessions.createLinked', { ...payload, name: 'Different name' }, commandId);
  expect(conflict.status).toBe(409);
  const overview = await (await f.query()).json();
  expect(overview.sessions).toHaveLength(2);
});

test('carry selection rejects unknown versions, external references and unavailable target environments with correctable errors', async () => {
  const { f, env, altProfile } = await fixture();
  const source = await createSessionWithTurn(f, env, 'Source work');
  const base = { sourceSessionId: source.id, name: 'Handoff', workspaceId: env.workspace.id, profileId: altProfile.id };
  const unknown = await f.command('sessions.createLinked', { ...base, carry: { files: [], artifactVersions: [{ versionId: crypto.randomUUID(), kind: 'text' }] } });
  expect(unknown.status).toBe(404); expect(await unknown.json()).toMatchObject({ error: { code: 'ARTIFACT_UNAVAILABLE' } });
  const external = (await (await f.command('artifacts.register', { workspaceId: env.workspace.id, title: 'Remote', source: { kind: 'external-reference', url: 'https://example.org/study' } })).json()).result;
  const rejected = await f.command('sessions.createLinked', { ...base, carry: { files: [], artifactVersions: [{ versionId: external.versionId, kind: 'text' }] } });
  expect(rejected.status).toBe(409); expect(await rejected.json()).toMatchObject({ error: { code: 'ARTIFACT_EXTERNAL_REFERENCE' } });
  const missingFile = await f.command('sessions.createLinked', { ...base, carry: { files: [{ workspaceId: env.workspace.id, path: 'no-such-file.md', kind: 'text' }], artifactVersions: [] } });
  expect(missingFile.status).toBe(404);
  const archived = await f.command('workspace.archive', { id: env.workspace.id });
  expect(archived.status).toBe(200);
  const unavailable = await f.command('sessions.createLinked', { ...base, carry: { summary: 'x' } });
  expect(unavailable.status).toBe(409);
  const notOwned = await f.command('sessions.createLinked', { ...base, sourceSessionId: crypto.randomUUID(), carry: {} });
  expect(notOwned.status).toBe(404); expect(await notOwned.json()).toMatchObject({ error: { code: 'SESSION_UNAVAILABLE' } });
  expect((await (await f.query()).json()).sessions).toHaveLength(1);
});

test('sendHandoff delivers only the selected carry as the first input of a fresh native session, exactly once', async () => {
  const { f, env, altProfile } = await fixture();
  const source = await createSessionWithTurn(f, env, 'Original question');
  await writeFile(join(env.workspace.directory, 'carry-file.md'), 'carried workspace bytes');
  const artifact = (await (await f.command('artifacts.register', { workspaceId: env.workspace.id, title: 'Carried report', source: { kind: 'captured-file', workspaceId: env.workspace.id, relativePath: 'carry-file.md' } })).json()).result;
  const linked = (await (await f.command('sessions.createLinked', { sourceSessionId: source.id, name: 'Alternate continuation', workspaceId: env.workspace.id, profileId: altProfile.id, carry: { summary: 'Continue with these materials.', files: [{ workspaceId: env.workspace.id, path: 'carry-file.md', kind: 'text' }], artifactVersions: [{ versionId: artifact.versionId, kind: 'text' }] } })).json()).result;
  expect((await f.command('sessions.sendHandoff', { sessionId: linked.id })).status).toBe(409); // no ready Run yet
  expect((await f.command('sessions.startRun', { sessionId: linked.id })).status).toBe(200);
  await waitFor(f, () => entry(f, linked.id).then(value => value.execution.state === 'ready'));
  const before = (await (await snapshot(f, 'sessions.handoff', { sessionId: linked.id })).json()).snapshot.handoff;
  expect(before.state).toBe('pending');
  const commandId = crypto.randomUUID();
  const send = await f.command('sessions.sendHandoff', { sessionId: linked.id }, commandId);
  expect(send.status).toBe(200);
  const receipt = await send.json();
  await waitFor(f, async () => (await (await resource(f, 'sessions.timeline', `sessionId=${linked.id}`)).json()).turns[0]?.state === 'completed');
  // Exactly one prompt with only the selected carry; a fresh native session; never a native load.
  const wireB = await wire(f, 'b');
  const prompts = wireB.filter(value => value.method === 'session/prompt');
  expect(prompts).toHaveLength(1);
  expect(prompts[0].params.prompt).toEqual([
    { type: 'text', text: 'Continue with these materials.' },
    { type: 'resource', resource: { uri: expect.stringContaining('carry-file.md'), mimeType: 'text/plain', text: 'carried workspace bytes' } },
    { type: 'resource', resource: { uri: `aork-artifact://version/${artifact.versionId}`, mimeType: 'text/plain', text: 'carried workspace bytes' } },
  ]);
  expect(wireB.filter(value => value.method === 'session/load')).toHaveLength(0);
  expect(wireB.filter(value => value.method === 'session/new')).toHaveLength(1);
  const timeline = await (await resource(f, 'sessions.timeline', `sessionId=${linked.id}`)).json();
  expect(timeline.messages.filter((message: any) => message.role === 'user').map((message: any) => message.text)).toEqual(['Continue with these materials.']);
  expect(timeline.turns[0].attachments).toEqual([
    { path: 'carry-file.md', kind: 'text', size: 23, sha256: timeline.turns[0].attachments[0].sha256 },
    { artifactVersionId: artifact.versionId, kind: 'text', size: 23, sha256: timeline.turns[0].attachments[1].sha256 },
  ]);
  const after = (await (await snapshot(f, 'sessions.handoff', { sessionId: linked.id })).json()).snapshot.handoff;
  expect(after.state).toBe('sent'); expect(after.turnId).toBe(timeline.turns[0].id);
  // Retry returns the original receipt; a new attempt is refused as already sent.
  expect(await (await f.command('sessions.sendHandoff', { sessionId: linked.id }, commandId)).json()).toEqual(receipt);
  expect((await (await f.command('sessions.sendHandoff', { sessionId: linked.id }))).status).toBe(409);
  expect((await wire(f, 'b')).filter(value => value.method === 'session/prompt')).toHaveLength(1);
});

test('handoff carry across Workspaces copies the selected file to a controlled target path', async () => {
  const { f, env, altProfile } = await fixture();
  const source = await createSessionWithTurn(f, env, 'Source work');
  await writeFile(join(env.workspace.directory, 'notes.txt'), 'cross workspace carry');
  const secondDirectory = join(f.directory, 'second'); await mkdir(secondDirectory, { recursive: true });
  const second = (await (await f.command('workspace.create', { workspace: { name: 'Second', management: 'external', directory: secondDirectory, access: 'read-write' } })).json()).result;
  const attempt4 = { sourceSessionId: source.id, name: 'Elsewhere', workspaceId: second.id, profileId: altProfile.id, carry: { files: [{ workspaceId: env.workspace.id, path: 'notes.txt', kind: 'text' }] } };
  const linkedResponse = await f.command('sessions.createLinked', attempt4);
  if (linkedResponse.status !== 200) throw new Error(`createLinked failed ${linkedResponse.status}: ${await linkedResponse.text()}`);
  const linked = (await linkedResponse.json()).result;
  const handoff = (await (await snapshot(f, 'sessions.handoff', { sessionId: linked.id })).json()).snapshot.handoff;
  expect(handoff.carry.files[0].path).toMatch(/^\.aork-handoff-[0-9a-f]{12}-notes\.txt$/);
  expect(await readFile(join(second.directory, handoff.carry.files[0].path), 'utf8')).toBe('cross workspace carry');
  // The copy is idempotent for a retried identical handoff.
  expect((await f.command('sessions.startRun', { sessionId: linked.id })).status).toBe(200);
  await waitFor(f, () => entry(f, linked.id).then(value => value.execution.state === 'ready'));
  expect((await f.command('sessions.sendHandoff', { sessionId: linked.id })).status).toBe(200);
  await waitFor(f, async () => (await (await resource(f, 'sessions.timeline', `sessionId=${linked.id}`)).json()).turns[0]?.state === 'completed');
  const prompt = (await wire(f, 'b')).filter(value => value.method === 'session/prompt')[0];
  expect(prompt.params.prompt[1].resource.text).toBe('cross workspace carry');
  expect(prompt.params.prompt[1].resource.uri).toContain(second.directory);
});

test('unsupported negotiated input keeps the handoff pending with a correctable error and sends nothing', async () => {
  const { f, env } = await fixture();
  const source = await createSessionWithTurn(f, env, 'Source work');
  await writeFile(join(env.workspace.directory, 'summary.md'), 'plain text is not audio');
  const linked = (await (await f.command('sessions.createLinked', { sourceSessionId: source.id, name: 'Same provider copy', workspaceId: env.workspace.id, profileId: env.profile.id, carry: { files: [{ workspaceId: env.workspace.id, path: 'summary.md', kind: 'audio' }] } })).json()).result;
  expect((await f.command('sessions.startRun', { sessionId: linked.id })).status).toBe(200);
  await waitFor(f, () => entry(f, linked.id).then(value => value.execution.state === 'ready'));
  // Provider A negotiates audio input; a text file claimed as audio is a correctable format error.
  const failed = await f.command('sessions.sendHandoff', { sessionId: linked.id });
  expect(failed.status).toBe(415); expect(await failed.json()).toMatchObject({ error: { code: 'RUN_INPUT_FORMAT_UNSUPPORTED' } });
  const handoff = (await (await snapshot(f, 'sessions.handoff', { sessionId: linked.id })).json()).snapshot.handoff;
  expect(handoff.state).toBe('pending');
  expect((await (await resource(f, 'sessions.timeline', `sessionId=${linked.id}`)).json()).turns).toHaveLength(0);
});

test('a registered Artifact version serves again as same-Session input under negotiated capability and access scope', async () => {
  const { f, env } = await fixture();
  await writeFile(join(env.workspace.directory, 'result.md'), 'reusable artifact result');
  const artifact = (await (await f.command('artifacts.register', { workspaceId: env.workspace.id, title: 'Reuse me', source: { kind: 'captured-file', workspaceId: env.workspace.id, relativePath: 'result.md' } })).json()).result;
  const session = (await (await f.command('sessions.create', env.input)).json()).result;
  expect((await f.command('sessions.startRun', { sessionId: session.id })).status).toBe(200);
  await waitFor(f, () => entry(f, session.id).then(value => value.execution.state === 'ready'));
  // The workspace file changes after registration; the attached input still carries the immutable version bytes.
  await writeFile(join(env.workspace.directory, 'result.md'), 'mutated workspace bytes');
  const commandId = crypto.randomUUID();
  const sent = await f.command('sessions.sendText', { sessionId: session.id, text: 'Continue from the saved version.', attachments: [{ artifactVersionId: artifact.versionId, kind: 'text' }] }, commandId);
  expect(sent.status).toBe(200);
  const turn = (await sent.json()).result;
  await waitFor(f, async () => (await (await resource(f, 'sessions.timeline', `sessionId=${session.id}`)).json()).turns.find((item: any) => item.id === turn.id)?.state === 'completed');
  const prompt = (await wire(f, 'a')).filter(value => value.method === 'session/prompt').at(-1)!;
  expect(prompt.params.prompt).toEqual([
    { type: 'text', text: 'Continue from the saved version.' },
    { type: 'resource', resource: { uri: `aork-artifact://version/${artifact.versionId}`, mimeType: 'text/plain', text: 'reusable artifact result' } },
  ]);
  const timeline = await (await resource(f, 'sessions.timeline', `sessionId=${session.id}`)).json();
  expect(timeline.turns.find((item: any) => item.id === turn.id).attachments).toEqual([{ artifactVersionId: artifact.versionId, kind: 'text', size: 24, sha256: timeline.turns[0].attachments[0].sha256 }]);
  // Retry returns the original receipt and creates no second Turn.
  expect((await (await f.command('sessions.sendText', { sessionId: session.id, text: 'Continue from the saved version.', attachments: [{ artifactVersionId: artifact.versionId, kind: 'text' }] }, commandId)).json()).result.id).toBe(turn.id);
  expect((await (await resource(f, 'sessions.timeline', `sessionId=${session.id}`)).json()).turns).toHaveLength(1);
});

test('artifact attachments reject unknown versions, external references and unsupported content with correctable errors', async () => {
  const { f, env } = await fixture();
  const session = (await (await f.command('sessions.create', env.input)).json()).result;
  expect((await f.command('sessions.startRun', { sessionId: session.id })).status).toBe(200);
  await waitFor(f, () => entry(f, session.id).then(value => value.execution.state === 'ready'));
  const unknown = await f.command('sessions.sendText', { sessionId: session.id, text: 'x', attachments: [{ artifactVersionId: crypto.randomUUID(), kind: 'text' }] });
  expect(unknown.status).toBe(404); expect(await unknown.json()).toMatchObject({ error: { code: 'ARTIFACT_UNAVAILABLE' } });
  const external = (await (await f.command('artifacts.register', { workspaceId: env.workspace.id, title: 'Remote', source: { kind: 'external-reference', url: 'https://example.org/x' } })).json()).result;
  const reference = await f.command('sessions.sendText', { sessionId: session.id, text: 'x', attachments: [{ artifactVersionId: external.versionId, kind: 'text' }] });
  expect(reference.status).toBe(409); expect(await reference.json()).toMatchObject({ error: { code: 'ARTIFACT_EXTERNAL_REFERENCE' } });
  await writeFile(join(env.workspace.directory, 'not-audio.txt'), 'plain text bytes');
  const audio = (await (await f.command('artifacts.register', { workspaceId: env.workspace.id, title: 'Wrong kind', source: { kind: 'captured-file', workspaceId: env.workspace.id, relativePath: 'not-audio.txt' } })).json()).result;
  const format = await f.command('sessions.sendText', { sessionId: session.id, text: 'x', attachments: [{ artifactVersionId: audio.versionId, kind: 'audio' }] });
  expect(format.status).toBe(415); expect(await format.json()).toMatchObject({ error: { code: 'RUN_INPUT_FORMAT_UNSUPPORTED' } });
  await writeFile(join(env.workspace.directory, 'large.bin'), Buffer.alloc(200 * 1024, 7));
  const large = (await (await f.command('artifacts.register', { workspaceId: env.workspace.id, title: 'Large', source: { kind: 'captured-file', workspaceId: env.workspace.id, relativePath: 'large.bin' } })).json()).result;
  const size = await f.command('sessions.sendText', { sessionId: session.id, text: 'x', attachments: [{ artifactVersionId: large.versionId, kind: 'text' }] });
  expect(size.status).toBe(413); expect(await size.json()).toMatchObject({ error: { code: 'RUN_INPUT_TOO_LARGE' } });
  expect((await (await resource(f, 'sessions.timeline', `sessionId=${session.id}`)).json()).turns).toHaveLength(0);
});

test('large artifact content is exposed as a controlled workspace reference without inlining, idempotently and claim-gated', async () => {
  const { f, env } = await fixture();
  const bytes = Buffer.alloc(300 * 1024, 9);
  await writeFile(join(env.workspace.directory, 'big-report.bin'), bytes);
  const artifact = (await (await f.command('artifacts.register', { workspaceId: env.workspace.id, title: 'Big report', source: { kind: 'captured-file', workspaceId: env.workspace.id, relativePath: 'big-report.bin' } })).json()).result;
  const exposed = await f.command('artifacts.exposeVersion', { versionId: artifact.versionId, workspaceId: env.workspace.id });
  expect(exposed.status).toBe(200);
  const reference = (await exposed.json());
  expect(reference.path.startsWith('.aork-artifact-')).toBe(true);
  expect(reference.path).not.toContain('/');
  expect(reference.path.endsWith('big-report.bin')).toBe(true);
  expect(reference.size).toBe(300 * 1024);
  expect(reference.sha256).toBe((await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'));
  expect(await readFile(join(env.workspace.directory, reference.path))).toEqual(bytes);
  // Repeated exposure of the immutable version verifies the existing bytes instead of failing.
  const again = await (await f.command('artifacts.exposeVersion', { versionId: artifact.versionId, workspaceId: env.workspace.id })).json();
  expect(again).toEqual(reference);
  // A held Run Claim on the Workspace blocks new controlled references with a correctable error.
  const session = (await (await f.command('sessions.create', env.input)).json()).result;
  expect((await f.command('sessions.startRun', { sessionId: session.id })).status).toBe(200);
  await waitFor(f, () => entry(f, session.id).then(value => value.execution.state === 'ready'));
  const blocked = await f.command('artifacts.exposeVersion', { versionId: artifact.versionId, workspaceId: env.workspace.id });
  expect(blocked.status).toBe(409); expect(await blocked.json()).toMatchObject({ error: { code: 'WORKSPACE_WRITE_BUSY' } });
  expect(await fetch(`${f.host.url}/api/commands/artifacts.exposeVersion`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: f.host.url }, body: JSON.stringify({ apiVersion: 1, commandVersion: 1, commandId: crypto.randomUUID(), pluginGraphHash: f.bootstrap.pluginGraphHash, payload: { versionId: artifact.versionId, workspaceId: env.workspace.id } }) }).then(value => value.status)).toBe(401);
});
