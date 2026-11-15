import { afterEach, expect, test } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionEnvironment, sessionHost } from './fixtures/session-host.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const peer = `import {createInterface} from 'node:readline';import{appendFileSync,existsSync}from'node:fs';import{randomUUID}from'node:crypto';
if(process.argv[2]==='--version'){console.log('1.2.3');process.exit(0);}const peerId=randomUUID();appendFileSync('peer-starts',peerId+'\\n');process.on('exit',()=>appendFileSync('peer-exits',peerId+'\\n'));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{if(existsSync('exit-peer'))process.exit(0);},20);let active;const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');
createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);appendFileSync('queue-wire',JSON.stringify(r)+'\\n');
if(r.method==='initialize')send({id:r.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});
if(r.method==='session/new')send({id:r.id,result:{sessionId:'queue-native'}});
if(r.method==='session/cancel'&&active){const id=active;active=undefined;send({id,result:{stopReason:'cancelled'}});}
if(r.method==='session/prompt'){if(active)appendFileSync('overlap','overlap');active=r.id;const text=r.params.prompt[0].text;send({method:'session/update',params:{sessionId:'queue-native',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Started '+text}}}});const timer=setInterval(()=>{if(active!==r.id){clearInterval(timer);return;}if(text==='hold'&&!existsSync('release'))return;clearInterval(timer);active=undefined;send({id:r.id,result:{stopReason:'end_turn'}});},20);}});`;
async function eventually<T>(read: () => Promise<T>, accepts: (value: T) => boolean) { let value: T; const deadline = Date.now() + 10000; do { value = await read(); if (accepts(value)) return value; await new Promise(resolve => setTimeout(resolve, 20)); } while (Date.now() < deadline); throw Error(JSON.stringify(value!)); }
async function peerIds(directory:string,name:string){try{return(await readFile(join(directory,name),'utf8')).trim().split('\n').filter(Boolean);}catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT')return[];throw error;}}
async function exitPeers(directory:string){const started=await peerIds(directory,'peer-starts');if(!started.length)return;await writeFile(join(directory,'exit-peer'),'exit');await eventually(()=>peerIds(directory,'peer-exits'),exited=>started.every(id=>exited.includes(id)));}
async function open(source = peer) { const f = await sessionHost();let peerDirectory:string|undefined;cleanup.push(async()=>{try{if(peerDirectory)await exitPeers(peerDirectory);}finally{await f.close();}}); await writeFile(join(f.directory, 'controlled-agent.mjs'), source); const env = await sessionEnvironment(f);peerDirectory=env.workspace.directory; const session = (await (await f.command('sessions.create', env.input)).json()).result; const run = (await (await f.command('sessions.startRun', { sessionId: session.id })).json()).result; await eventually(async () => (await (await f.query()).json()), v => v.sessions[0]?.execution.state === 'ready'); return { f, env, session, run }; }
async function timeline(f: Awaited<ReturnType<typeof sessionHost>>, id: string) { return (await fetch(`${f.host.url}/api/resources/sessions.timeline?sessionId=${id}`, { headers: { Cookie: f.cookie } })).json(); }
async function wire(directory: string) { try { return (await readFile(join(directory, 'queue-wire'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } }

test('concurrent inputs are durable ordered queue receipts while one prompt runs, and only undeleted inputs reach ACP once', async () => {
  const { f, env, session } = await open();
  await f.command('sessions.sendText', { sessionId: session.id, text: 'hold' });
  await eventually(() => timeline(f, session.id), value => value.turns[0]?.state === 'running');
  const attempts = ['  second 🌏  ', 'remove me', 'fourth'].map(text => ({ payload: { sessionId: session.id, text }, id: crypto.randomUUID() }));
  const responses = await Promise.all(attempts.map(attempt => f.command('sessions.sendText', attempt.payload, attempt.id)));
  expect(responses.map(response => response.status)).toEqual([200, 200, 200]);
  const receipts = await Promise.all(responses.map(response => response.json()));
  expect(receipts.every(receipt => receipt.result.state === 'queued')).toBe(true);
  const queued = (await timeline(f, session.id)).turns.filter((turn: { state: string }) => turn.state === 'queued');
  expect(queued.map((turn: { acceptanceOrder: number }) => turn.acceptanceOrder)).toEqual([2, 3, 4]);
  for (let i = 0; i < attempts.length; i++) expect(await (await f.command('sessions.sendText', attempts[i]!.payload, attempts[i]!.id)).json()).toEqual(receipts[i]);
  expect((await f.command('sessions.sendText', { ...attempts[0]!.payload, text: 'changed' }, attempts[0]!.id)).status).toBe(409);
  const removed = await f.command('sessions.removeQueuedTurn', { turnId: receipts[1].result.id }); expect(removed.status).toBe(200); expect((await removed.json()).result.state).toBe('removed');
  expect((await f.command('sessions.removeQueuedTurn', { turnId: receipts[0].result.id })).status).toBe(200);
  expect((await wire(env.workspace.directory)).filter(r => r.method === 'session/prompt')).toHaveLength(1);
  await writeFile(join(env.workspace.directory, 'release'), 'go');
  await eventually(() => timeline(f, session.id), value => value.turns.at(-1)?.state === 'completed');
  expect((await wire(env.workspace.directory)).filter(r => r.method === 'session/prompt').map(r => r.params.prompt[0].text)).toEqual(['hold', 'fourth']);
  await expect(readFile(join(env.workspace.directory, 'overlap'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await f.command('sessions.removeQueuedTurn', { turnId: receipts[2].result.id })).status).toBe(409);
  expect(await (await f.command('sessions.sendText', attempts[2]!.payload, attempts[2]!.id)).json()).toEqual(receipts[2]);
});

test('cancel pauses retained queue until explicit continue of the current ready Run, including reload and idempotent continue', async () => {
  const { f, env, session, run } = await open();
  const first = (await (await f.command('sessions.sendText', { sessionId: session.id, text: 'hold' })).json()).result;
  await eventually(() => timeline(f, session.id), v => v.turns[0]?.state === 'running');
  const queued = await f.command('sessions.sendText', { sessionId: session.id, text: 'after cancellation' }); expect(queued.status).toBe(200);
  await f.command('sessions.cancelTurn', { turnId: first.id });
  const paused = await eventually(() => timeline(f, session.id), v => v.turns[0]?.state === 'cancelled'); expect(paused.dispatchPaused).toBe(true); expect(paused.turns[1].state).toBe('queued');
  expect((await wire(env.workspace.directory)).filter(r => r.method === 'session/prompt').map(r => r.params.prompt[0].text)).toEqual(['hold']);
  expect((await (await f.query()).json()).sessions[0].dispatchPaused).toBe(true);
  const attempt = crypto.randomUUID(); const continued = await f.command('sessions.continueQueue', { sessionId: session.id, runId: run.runId }, attempt); expect(continued.status).toBe(200); const receipt = await continued.json();
  await eventually(() => timeline(f, session.id), v => v.turns[1]?.state === 'completed');
  expect(await (await f.command('sessions.continueQueue', { sessionId: session.id, runId: run.runId }, attempt)).json()).toEqual(receipt);
  expect((await wire(env.workspace.directory)).filter(r => r.method === 'session/prompt').map(r => r.params.prompt[0].text)).toEqual(['hold', 'after cancellation']);
});

test('restart retains queue paused and uncertain attempted input is never a retry candidate; new native context requires explicit choice', async () => {
  const silent = peer.replace("send({method:'session/update',params:{sessionId:'queue-native',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Started '+text}}}});", '');
  const { f, env, session, run } = await open(silent);
  await f.command('sessions.sendText', { sessionId: session.id, text: 'hold' });
  await eventually(() => wire(env.workspace.directory), requests => requests.some(r => r.method === 'session/prompt'));
  const queued = await f.command('sessions.sendText', { sessionId: session.id, text: 'retained next input' }); expect(queued.status).toBe(200); const original = await queued.json();
  await f.restart();
  const state = await timeline(f, session.id); expect(state.dispatchPaused).toBe(true); expect(state.turns.map((turn: { state: string }) => turn.state)).toEqual(['delivery_unknown', 'queued']);
  expect(state.messages.map((m: { text: string }) => m.text)).toEqual(['hold', 'retained next input']);
  expect((await f.command('sessions.continueQueue', { sessionId: session.id, runId: run.runId })).status).toBe(409);
  const next = (await (await f.command('sessions.startRun', { sessionId: session.id })).json()).result;
  await eventually(async () => (await (await f.query()).json()), v => v.sessions[0].execution.state === 'ready');
  expect((await f.command('sessions.continueQueue', { sessionId: session.id, runId: next.runId })).status).toBe(409);
  expect((await wire(env.workspace.directory)).filter(r => r.method === 'session/prompt')).toHaveLength(1);
  expect((await f.command('sessions.continueQueue', { sessionId: session.id, runId: next.runId, allowNewContext: true })).status).toBe(200);
  await eventually(() => timeline(f, session.id), v => v.turns[1]?.state === 'completed');
  const result = await timeline(f, session.id); expect(result.turns[0].runId).toBe(run.runId); expect(result.turns[1].runId).toBe(next.runId);
  expect((await wire(env.workspace.directory)).filter(r => r.method === 'session/prompt').map(r => r.params.prompt[0].text)).toEqual(['hold', 'retained next input']);
  const repeat = await f.command('sessions.sendText', { sessionId: session.id, text: 'retained next input' }, original.commandId); expect(await repeat.json()).toEqual(original);
});

test('Host crash preserves delivery_unknown without replay while queued work remains separately removable', async () => {
  const silent = peer.replace("send({method:'session/update',params:{sessionId:'queue-native',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Started '+text}}}});", '');
  const { f, env, session } = await open(silent);
  try{
  await f.command('sessions.sendText', { sessionId: session.id, text: 'hold' });
  await eventually(() => wire(env.workspace.directory), requests => requests.some(r => r.method === 'session/prompt'));
  const next = (await (await f.command('sessions.sendText', { sessionId: session.id, text: 'not attempted' })).json()).result;
  await f.crashAndRestart(); const state = await timeline(f, session.id);
  expect(state.dispatchPaused).toBe(true); expect(state.turns.map((turn: { state: string }) => turn.state)).toEqual(['delivery_unknown', 'queued']);
  expect((await f.command('sessions.removeQueuedTurn', { turnId: state.turns[0].id })).status).toBe(409);
  expect((await f.command('sessions.removeQueuedTurn', { turnId: next.id })).status).toBe(200);
  expect((await wire(env.workspace.directory)).filter(r => r.method === 'session/prompt')).toHaveLength(1);
  expect((await timeline(f, session.id)).messages.map((m: { text: string }) => m.text)).toEqual(['hold', 'not attempted']);
  expect(await peerIds(env.workspace.directory,'peer-exits')).toEqual([]);
  }finally{await exitPeers(env.workspace.directory);}
  expect(await peerIds(env.workspace.directory,'peer-exits')).toEqual(await peerIds(env.workspace.directory,'peer-starts'));
});

test('dispatching and queue pause have Sessions-owned browser events and losing deletion never reports removed', async () => {
  const { f, env, session } = await open();
  const receipt = await (await f.command('sessions.sendText', { sessionId: session.id, text: 'hold' })).json();
  await eventually(() => timeline(f, session.id), v => v.turns[0]?.state === 'running');
  const late = await f.command('sessions.removeQueuedTurn', { turnId: receipt.result.id }); expect(late.status).toBe(409); expect((await late.json()).error.code).toBe('TURN_ALREADY_DISPATCHED');
  const accepted = await (await f.command('sessions.sendText', { sessionId: session.id, text: 'ordered next' })).json();
  await f.command('sessions.cancelTurn', { turnId: receipt.result.id });
  await eventually(() => timeline(f, session.id), v => v.turns[0]?.state === 'cancelled');
  const events = (await (await fetch(`${f.host.url}/api/events?after=0&limit=100`, { headers: { Cookie: f.cookie } })).json()).events;
  expect(events).toContainEqual(expect.objectContaining({ owner: 'sessions', type: 'sessions.turnChanged', entityId: receipt.result.id, payload: expect.objectContaining({ state: 'dispatching' }) }));
  expect(events).toContainEqual(expect.objectContaining({ owner: 'sessions', type: 'sessions.queueChanged', entityId: session.id, payload: { sessionId: session.id, dispatchPaused: true } }));
  expect((await timeline(f, session.id)).turns.find((turn: { id: string }) => turn.id === accepted.result.id).state).toBe('queued');
  expect((await wire(env.workspace.directory)).filter(r => r.method === 'session/prompt').map(r => r.params.prompt[0].text)).toEqual(['hold']);
});

test('public snapshots include queued order and tombstones with the cursor of their owner events', async () => {
  const { f, session } = await open();
  await f.command('sessions.sendText', { sessionId: session.id, text: 'hold' }); await eventually(() => timeline(f, session.id), v => v.turns[0]?.state === 'running');
  const receipt = await (await f.command('sessions.sendText', { sessionId: session.id, text: 'snapshot queued' })).json();
  const read = async (name: string, query = '') => { const response = await fetch(`${f.host.url}/api/snapshots/${name}${query}`, { headers: { Cookie: f.cookie, 'X-Aork-Graph': f.bootstrap.pluginGraphHash } }); expect(response.status).toBe(200); return response.json(); };
  const before = await read('sessions.timeline', `?sessionId=${session.id}`); expect(before.snapshot.turns[1]).toMatchObject({ id: receipt.result.id, state: 'queued', acceptanceOrder: 2 }); expect(before.snapshot.messages.some((message: { text: string }) => message.text === 'snapshot queued')).toBe(true);
  const projection = await read('sessions.overview'); expect(projection.snapshot.sessions[0].currentTurn.state).toBe('running'); expect(projection.snapshot.sessions[0]).not.toHaveProperty('environment');
  await f.command('sessions.removeQueuedTurn', { turnId: receipt.result.id });
  const after = await read('sessions.timeline', `?sessionId=${session.id}`); expect(after.streamId).toBe(before.streamId); expect(BigInt(after.cursor)).toBeGreaterThan(BigInt(before.cursor)); expect(after.snapshot.turns[1].state).toBe('removed');
  expect((await timeline(f, session.id)).messages.find((message: { turnId: string }) => message.turnId === receipt.result.id).text).toBe('snapshot queued');
});

for (const target of ['Workspace','Project'] as const) test(`an archived ${target} pauses its queued Session without starving unrelated ready Sessions`, async () => {
  const { f, env, session } = await open();
  await f.command('sessions.sendText', { sessionId: session.id, text: 'hold' });
  await eventually(() => timeline(f, session.id), value => value.turns[0]?.state === 'running');
  const retained = (await (await f.command('sessions.sendText', { sessionId: session.id, text: 'kept in archived environment' })).json()).result;
  const other = await sessionEnvironment(f); const otherSession = (await (await f.command('sessions.create',other.input)).json()).result;
  expect((await f.command('sessions.startRun',{sessionId:otherSession.id})).status).toBe(200);
  await eventually(async ()=>(await(await f.query()).json()),value=>value.sessions.find((entry:{session:{id:string}})=>entry.session.id===otherSession.id)?.execution.state==='ready');
  expect((await f.command(target==='Workspace'?'workspace.archive':'workspace.archiveProject',{id:target==='Workspace'?env.workspace.id:env.project.id})).status).toBe(200);
  await writeFile(join(env.workspace.directory,'release'),'go');
  await eventually(()=>timeline(f,session.id),value=>value.turns[0]?.state==='completed');
  expect((await f.command('sessions.sendText',{sessionId:otherSession.id,text:'unrelated healthy input'})).status).toBe(200);
  await eventually(()=>timeline(f,otherSession.id),value=>value.turns[0]?.state==='completed');
  const blocked=await timeline(f,session.id);expect(blocked.dispatchPaused).toBe(true);expect(blocked.turns[1]).toMatchObject({id:retained.id,state:'queued'});
  expect((await wire(env.workspace.directory)).filter(request=>request.method==='session/prompt').map(request=>request.params.prompt[0].text)).toEqual(['hold']);
  const events=(await(await fetch(`${f.host.url}/api/events?after=0&limit=100`,{headers:{Cookie:f.cookie}})).json()).events;
  expect(events).toContainEqual(expect.objectContaining({owner:'sessions',type:'sessions.queueChanged',entityId:session.id,payload:{sessionId:session.id,dispatchPaused:true}}));
});
