import { afterEach, expect, test } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionHost, sessionEnvironment } from './fixtures/session-host.js';
import { waitInput } from './fixtures/structured-host.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse())
    await close(); });
export const completedAgent = `import{createInterface}from'node:readline';if(process.argv[2]==='--version'){console.log('1.2.3');process.exit(0);}const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.method==='initialize')send({id:r.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});if(r.method==='session/new')send({id:r.id,result:{sessionId:'native-read'}});if(r.method==='session/prompt'){send({method:'session/update',params:{sessionId:'native-read',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Completed reply: '+r.params.prompt[0].text}}}});send({id:r.id,result:{stopReason:'end_turn'}});}});`;
async function snapshot(f: Awaited<ReturnType<typeof sessionHost>>, name: string, parameters: Record<string, string> = {}) { return fetch(`${f.host.url}/api/snapshots/${name}?${new URLSearchParams(parameters)}`, { headers: { Cookie: f.cookie, 'X-Aork-Graph': f.bootstrap.pluginGraphHash } }); }
test('completed replies have exact owner watermarks; reading one reply leaves other sessions and future content unread across restart', async () => {
    const f = await sessionHost();
    cleanup.push(() => f.close());
    await writeFile(join(f.directory, 'controlled-agent.mjs'), completedAgent);
    const env = await sessionEnvironment(f);
    const sessions: Array<{
        id: string;
        name: string;
    }> = [];
    for (const name of ['One', 'Two']) {
        const session = (await (await f.command('sessions.create', { ...env.input, name, workspaceId: name === 'One' ? env.workspace.id : (await (await f.command('workspace.create', { projectId: env.project.id, workspace: { name: 'Other', management: 'managed' } })).json()).result.id })).json()).result;
        sessions.push(session);
        await f.command('sessions.startRun', { sessionId: session.id });
    }
    await waitInput(async () => await (await f.query()).json(), v => v.sessions.every((s: any) => s.execution.state === 'ready'));
    for (const session of sessions)
        await f.command('sessions.sendText', { sessionId: session.id, text: session.name });
    const initial = await snapshot(f, 'workbench.unread');
    expect(initial.status).toBe(200);
    const unread = await waitInput(async () => (await (await snapshot(f, 'workbench.unread')).json()).snapshot, v => v.count === 2);
    expect(unread.items.map((v: any) => v.sessionId).sort()).toEqual(sessions.map(v => v.id).sort());
    const one = unread.items.find((v: any) => v.sessionId === sessions[0]!.id);
    const shown = (await (await snapshot(f, 'sessions.timeline', { sessionId: sessions[0]!.id })).json()).snapshot;
    expect(shown.completedReplies).toContainEqual({ activityId: one.activityId, turnId: one.turnId });
    expect((await f.command('workbench.markRead', { sessionId: sessions[1]!.id, activityIds: [one.activityId] })).status).toBe(404);
    const commandId = crypto.randomUUID();
    const response = await f.command('workbench.markRead', { sessionId: sessions[0]!.id, activityIds: [one.activityId] }, commandId);
    expect(response.status).toBe(200);
    expect(await (await f.command('workbench.markRead', { sessionId: sessions[0]!.id, activityIds: [one.activityId] }, commandId)).json()).toEqual(await response.json());
    await f.command('sessions.sendText', { sessionId: sessions[0]!.id, text: 'Future' });
    await waitInput(async () => (await (await snapshot(f, 'workbench.unread')).json()).snapshot, v => v.count === 2);
    await f.restart();
    const retained = (await (await snapshot(f, 'workbench.unread')).json()).snapshot;
    expect(retained.count).toBe(2);
    expect(retained.items.some((v: any) => v.activityId === one.activityId)).toBe(false);
    expect((await snapshot(f, 'workbench.unread', { after: 'invalid' })).status).toBe(400);
});
test('pending index covers native permissions and forms across projects without ordinary questions or expired requests', async () => {
    const f = await sessionHost();
    cleanup.push(() => f.close());
    const { structuredAgent, startStructured } = await import('./fixtures/structured-host.js');
    const one = await startStructured(f);
    const form = (await waitInput(async () => await (await f.query('interactions.inputPending')).json(), v => v.pending.length === 1)).pending[0];
    const response = await snapshot(f, 'interactions.pendingIndex');
    expect(response.status).toBe(200);
    const index = (await response.json()).snapshot;
    expect(index).toMatchObject({ count: 1, items: [{ id: form.id, sessionId: one.session.id, kind: 'form' }] });
    await f.command('interactions.submit', { interactionId: form.id, action: 'decline' });
    await waitInput(async () => (await (await snapshot(f, 'interactions.pendingIndex')).json()).snapshot, v => v.count === 0);
    expect((await snapshot(f, 'interactions.pendingIndex', { after: 'nonsense' })).status).toBe(400);
});
test('a bounded index counts all sixty live requests and exact selected details do not disappear behind history limits', async () => {
    const { openWorkbench } = await import('./fixtures/workbench-host.js');
    const f = await sessionHost();
    cleanup.push(() => f.close());
    const { session } = await openWorkbench(f, 'many');
    await openWorkbench(f, 'many', 'Second project');
    await openWorkbench(f, 'many', 'Third project');
    await openWorkbench(f, 'many', 'Fourth project');
    const first = await waitInput(async () => (await (await snapshot(f, 'interactions.pendingIndex')).json()).snapshot, v => v.count === 60);
    expect(first.items).toHaveLength(50);
    expect(first.next).toBeTruthy();
    const second = (await (await snapshot(f, 'interactions.pendingIndex', { after: first.next })).json()).snapshot;
    expect(second.count).toBe(60);
    expect(second.items).toHaveLength(10);
    expect(new Set([...first.items, ...second.items].map(v => v.id)).size).toBe(60);
    const selected = (await (await snapshot(f, 'interactions.request', { id: first.items[0].id })).json()).snapshot;
    expect(selected).toMatchObject({ id: first.items[0].id, state: 'pending' });
    for (const entry of (await (await f.query()).json()).sessions)
        await f.command('sessions.cancelTurn', { turnId: entry.currentTurn.id });
    await waitInput(async () => (await (await snapshot(f, 'interactions.pendingIndex')).json()).snapshot, v => v.count === 0);
});
test('opening a paged completed reply returns its exact content and never acknowledges pages which were not opened', async () => {
    const { openWorkbench } = await import('./fixtures/workbench-host.js');
    const f = await sessionHost();
    cleanup.push(() => f.close());
    const { session, turn } = await openWorkbench(f, 'long');
    await waitInput(async () => (await (await snapshot(f, 'workbench.unread')).json()).snapshot, v => v.count === 1);
    const first = await snapshot(f, 'sessions.reply', { turnId: turn.id });
    expect(first.status).toBe(200);
    const page = (await first.json()).snapshot;
    expect(page.messages).toHaveLength(50);
    expect(page.next).toBeTruthy();
    expect(page.activityId).toBe(turn.id);
    const last = (await (await snapshot(f, 'sessions.reply', { turnId: turn.id, after: page.next })).json()).snapshot;
    expect(last.messages).toHaveLength(5);
    expect(last.next).toBeUndefined();
    expect(last.messages.at(-1).text).toBe('Reply page 54\n');
    expect((await (await snapshot(f, 'workbench.unread')).json()).snapshot.count).toBe(1);
});

test('an early exact read has no receipt until the live reply projects, then the same ID is safe to retry',async()=>{
 const {openWorkbench}=await import('./fixtures/workbench-host.js');const f=await sessionHost();cleanup.push(()=>f.close());
 const existing=await openWorkbench(f,'Previously completed');await waitInput(async()=>await(await f.query('workbench.unread')).json(),value=>value.count===1);
 const turn=(await(await f.command('sessions.sendText',{sessionId:existing.session.id,text:'permission'})).json()).result;await waitInput(async()=>await(await f.query('interactions.pending')).json(),value=>value.pending.length===1);
 const commandId=crypto.randomUUID();const payload={sessionId:existing.session.id,activityIds:[turn.id]};expect((await f.command('workbench.markRead',payload,commandId)).status).toBe(404);
 expect((await fetch(`${f.host.url}/api/receipts/${commandId}`,{headers:{Cookie:f.cookie}})).status).toBe(404);
 const request=(await(await f.query('interactions.pending')).json()).pending[0];await f.command('interactions.respond',{interactionId:request.id,optionId:'deny'});await waitInput(async()=>await(await f.query('workbench.unread')).json(),value=>value.count===2);
 const response=await f.command('workbench.markRead',payload,commandId);expect(response.status).toBe(200);expect((await(await f.query('workbench.unread')).json()).count).toBe(1);
 expect((await fetch(`${f.host.url}/api/snapshots/workbench.unread`)).status).toBe(401);
});

test('final compact history never exposes a read watermark for an incomplete Agent reply, while exact reply pages remain available',async()=>{
 const {openWorkbench,workbenchAgent}=await import('./fixtures/workbench-host.js');const f=await sessionHost();cleanup.push(()=>f.close());
 const large=workbenchAgent.replace("else if(text==='long'){", "else if(text==='large'){for(let i=0;i<128;i++)send({method:'session/update',params:{sessionId:'native-workbench',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'x'.repeat(8000)}}}});send({id:r.id,result:{stopReason:'end_turn'}});}else if(text==='long'){");
 const {session,turn}=await openWorkbench(f,'large','Large compact reply',large);await waitInput(async()=>await(await f.query('workbench.unread')).json(),value=>value.count===1);
 const response=await snapshot(f,'sessions.timeline',{sessionId:session.id});expect(response.status).toBe(200);const dto=await response.json();expect(Buffer.byteLength(JSON.stringify(dto.snapshot))).toBeLessThanOrEqual(900000);expect(dto.snapshot.turns).toContainEqual(expect.objectContaining({id:turn.id,state:'completed'}));expect(dto.snapshot.messages.filter((message:any)=>message.role==='agent').map((message:any)=>message.text).join('').length).toBeLessThan(1024000);expect(dto.snapshot.completedReplies).toEqual([]);
 const page=(await(await snapshot(f,'sessions.reply',{turnId:turn.id})).json()).snapshot;expect(page.messages).toHaveLength(50);expect(page.next).toBeTruthy();expect((await(await f.query('workbench.unread')).json()).count).toBe(1);
});

test('legal escaped and Unicode native form titles keep the pending index byte-bounded and every live identity discoverable', async () => {
    const { structuredAgent, startStructured, formRequest } = await import('./fixtures/structured-host.js');
    const f = await sessionHost(); cleanup.push(() => f.close());
    const escapedTitle = '\u0001'.repeat(500);
    const unicodeTitle = '界🌏"\\\u0001'.repeat(80) + '界'.repeat(20);
    expect(escapedTitle.length).toBe(500); expect(unicodeTitle.length).toBe(500);
    const expected = new Map<string, string>();
    for (const title of [escapedTitle, escapedTitle, escapedTitle, unicodeTitle]) {
        const source = structuredAgent({ ...formRequest, message: title }).replace("send({id:0,method:'elicitation/create'", "for(let index=0;index<15;index++)send({id:'form-'+index,method:'elicitation/create'");
        const { session } = await startStructured(f, source); expected.set(session.id, title);
        await waitInput(async () => (await (await snapshot(f, 'interactions.inputPending', { sessionId: session.id })).json()).snapshot, value => value.pending.length === 15);
    }
    const firstResponse = await snapshot(f, 'interactions.pendingIndex'); expect(firstResponse.status).toBe(200);
    const firstEncoded = await firstResponse.text(); expect(Buffer.byteLength(firstEncoded)).toBeLessThanOrEqual(100000);
    const first = JSON.parse(firstEncoded).snapshot;
    expect(first.count).toBe(60); expect(first.items.length).toBeGreaterThan(0); expect(first.items.length).toBeLessThan(50);
    expect(first.next).toBe(first.items.at(-1).id);
    const all = [...first.items]; const cursors = new Set<string>(); let cursor = first.next;
    while (cursor) {
        expect(cursors.has(cursor)).toBe(false); cursors.add(cursor);
        const response = await snapshot(f, 'interactions.pendingIndex', { after: cursor }); expect(response.status).toBe(200);
        const encoded = await response.text(); expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(100000);
        const page = JSON.parse(encoded).snapshot; expect(page.count).toBe(60); expect(page.items.length).toBeGreaterThan(0);
        expect((await (await snapshot(f, 'interactions.pendingIndex', { after: cursor })).json()).snapshot).toEqual(page);
        if (page.next) expect(page.next).toBe(page.items.at(-1).id);
        all.push(...page.items); cursor = page.next;
    }
    expect(all).toHaveLength(60); expect(new Set(all.map(item => item.id)).size).toBe(60);
    expect(all.map(item => item.id)).toEqual([...all.map(item => item.id)].sort());
    for (const item of all) {
        expect(item.kind).toBe('form'); expect(item.title).toBe(expected.get(item.sessionId));
        const response = await snapshot(f, 'interactions.request', { id: item.id }); expect(response.status).toBe(200);
        const detail = (await response.json()).snapshot;
        expect(detail).toMatchObject({ id: item.id, sessionId: item.sessionId, state: 'pending', title: expected.get(item.sessionId) });
        expect(Buffer.byteLength(JSON.stringify(detail))).toBeLessThan(24000);
    }
    expect((await f.command('interactions.submit', { interactionId: all[0].id, action: 'decline' })).status).toBe(200);
    await waitInput(async () => (await (await snapshot(f, 'interactions.pendingIndex')).json()).snapshot, value => value.count === 59);
    expect((await f.query()).status).toBe(200);
});

test('fifty legal escaped Session names keep every owned reference bounded with explicit labels and exact full detail', async () => {
    const f = await sessionHost(); cleanup.push(() => f.close()); const env = await sessionEnvironment(f);
    const names = Array.from({ length: 50 }, (_, index) => '\u0001'.repeat(117) + String(index).padStart(3, '0'));
    expect(names.every(name => name.length === 120)).toBe(true);
    const responses = await Promise.all(names.map(name => f.command('sessions.create', { ...env.input, name })));
    expect(responses.every(response => response.status === 200)).toBe(true);
    const sessions = await Promise.all(responses.map(async response => (await response.json()).result));
    const parameters = { ids: sessions.map(session => session.id).join(',') };
    const response = await snapshot(f, 'sessions.references', parameters); expect(response.status).toBe(200);
    const encoded = await response.text(); expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(32768);
    const references = JSON.parse(encoded).snapshot.sessions;
    expect(references.map((reference: { id: string }) => reference.id)).toEqual(sessions.map(session => session.id));
    for (const reference of references) {
        const session = sessions.find(value => value.id === reference.id)!;
        expect(reference).toMatchObject({ id: session.id, projectId: env.project.id, workspaceId: env.workspace.id, nameTruncated: true });
        expect(Buffer.byteLength(JSON.stringify(reference.name))).toBeLessThanOrEqual(256);
        expect(session.name.startsWith(reference.name)).toBe(true); expect(reference.name).not.toBe(session.name);
        const detail = await fetch(`${f.host.url}/api/resources/sessions.detail?id=${session.id}`, { headers: { Cookie: f.cookie } }); expect(detail.status).toBe(200);
        expect((await detail.json()).session).toMatchObject({ id: session.id, name: session.name, projectId: env.project.id, workspaceId: env.workspace.id });
    }
    expect((await fetch(`${f.host.url}/api/snapshots/sessions.references?${new URLSearchParams(parameters)}`)).status).toBe(401);
    expect((await fetch(`${f.host.url}/api/resources/sessions.detail?id=${sessions[0].id}`)).status).toBe(401);
    const unknown = crypto.randomUUID();
    const scoped = (await (await snapshot(f, 'sessions.references', { ids: [...sessions.slice(0, 49).map(session => session.id), unknown].join(',') })).json()).snapshot.sessions;
    expect(scoped.map((reference: { id: string }) => reference.id)).toEqual(sessions.slice(0, 49).map(session => session.id));
    expect((await fetch(`${f.host.url}/api/resources/sessions.detail?id=${unknown}`, { headers: { Cookie: f.cookie } })).status).toBe(404);
    const normal = await Promise.all(Array.from({ length: 50 }, async (_, index) => (await (await f.command('sessions.create', { ...env.input, name: `Ordinary ${index}` })).json()).result));
    const ordinary = (await (await snapshot(f, 'sessions.references', { ids: normal.map(session => session.id).join(',') })).json()).snapshot.sessions;
    expect(ordinary).toEqual(normal.map(session => ({ id: session.id, name: session.name, projectId: env.project.id, workspaceId: env.workspace.id })));
    const unicodeName='🌏\u0001'.repeat(40);
    const unicode=(await(await f.command('sessions.create',{...env.input,name:unicodeName})).json()).result;
    const unicodeReference=(await(await snapshot(f,'sessions.references',{ids:unicode.id})).json()).snapshot.sessions[0];
    expect(unicodeReference.nameTruncated).toBe(true);expect(Buffer.byteLength(JSON.stringify(unicodeReference.name))).toBeLessThanOrEqual(256);
    expect([...unicodeReference.name].every(point=>point==='🌏'||point==='\u0001')).toBe(true);expect(unicodeName.startsWith(unicodeReference.name)).toBe(true);
});
