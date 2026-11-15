import { afterEach, expect, test } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionEnvironment, sessionHost } from './fixtures/session-host.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const agent = `import {createInterface} from 'node:readline';import{appendFileSync}from'node:fs';
if(process.argv[2]==='--version'){console.log('1.2.3');process.exit(0);}
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');let prompt;
createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);appendFileSync('permission-wire',JSON.stringify(r)+'\\n');
if(r.method==='initialize')send({id:r.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});
if(r.method==='session/new')send({id:r.id,result:{sessionId:'permission-native'}});
if(r.method==='session/prompt'){prompt=r;send({id:0,method:'session/request_permission',params:{sessionId:'permission-native',toolCall:{toolCallId:'write-1',title:'Write research notes',status:'pending'},options:[{optionId:'allow-once',name:'Allow once',kind:'allow_once'},{optionId:'deny-once',name:'Reject once',kind:'reject_once'}]}});}
if(r.method==='session/cancel')send({id:prompt.id,result:{stopReason:'cancelled'}});
});`;
async function waitFor<T>(read: () => Promise<T>, accept: (value: T) => boolean) { const deadline = Date.now() + 10000; let value: T; do { value = await read(); if (accept(value)) return value; await new Promise(resolve => setTimeout(resolve, 20)); } while (Date.now() < deadline); throw Error('Expected state not reached: ' + JSON.stringify(value!)); }
async function open(source = agent) { const f = await sessionHost(); cleanup.push(() => f.close()); await writeFile(join(f.directory, 'controlled-agent.mjs'), source); const env = await sessionEnvironment(f); const session = (await (await f.command('sessions.create', env.input)).json()).result; const run = (await (await f.command('sessions.startRun', { sessionId: session.id })).json()).result; await waitFor(async () => await (await f.query()).json(), value => value.sessions[0]?.execution.state === 'ready'); await f.command('sessions.sendText', { sessionId: session.id, text: 'request permission' }); const pending = await waitFor(async () => await (await f.query('interactions.pending')).json(), value => value.pending?.length === 1); return { f, env, session, run, interaction: pending.pending[0] }; }
async function detail(f: Awaited<ReturnType<typeof sessionHost>>, id: string) { return await (await fetch(`${f.host.url}/api/resources/interactions.detail?id=${id}`, { headers: { Cookie: f.cookie } })).json(); }
async function wire(f: Awaited<ReturnType<typeof sessionHost>>, directory: string) { return (await readFile(join(directory, 'permission-wire'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)); }

test('an offered option is claimed once, sent on the typed native RPC, and command retries preserve the accepted receipt', async () => {
  const { f, env, interaction } = await open();
  const payload = { interactionId: interaction.id, optionId: 'deny-once' }; const commandId = crypto.randomUUID();
  expect((await f.command('interactions.respond', { ...payload, optionId: 'invented' })).status).toBe(400);
  expect((await f.command('interactions.respond', { ...payload, generation: 500 })).status).toBe(400);
  const response = await f.command('interactions.respond', payload, commandId); expect(response.status).toBe(200); const receipt = await response.json(); expect(receipt.result.state).toBe('responding');
  expect(await (await f.command('interactions.respond', payload, commandId)).json()).toEqual(receipt);
  expect((await f.command('interactions.respond', { ...payload, optionId: 'allow-once' }, commandId)).status).toBe(409);
  await waitFor(() => detail(f, interaction.id), value => value.state === 'responded');
  expect((await f.command('interactions.respond', payload)).status).toBe(409);
  const responses = (await wire(f, env.workspace.directory)).filter(value => value.id === 0 && value.result);
  expect(responses).toEqual([{ jsonrpc: '2.0', id: 0, result: { outcome: { outcome: 'selected', optionId: 'deny-once' } } }]);
  expect(await (await f.query('interactions.pending')).json()).toEqual({ pending: [] });
});

test('two independent response commands claim only one offered option and retain the healthy Run Claim', async () => {
  const { f, env, interaction } = await open();
  const responses = await Promise.all(['allow-once','deny-once'].map(optionId => f.command('interactions.respond', { interactionId:interaction.id, optionId })));
  expect(responses.map(value=>value.status).sort()).toEqual([200,409]);
  await waitFor(()=>detail(f,interaction.id),value=>value.state==='responded');
  expect((await wire(f,env.workspace.directory)).filter(value=>value.id===0&&value.result)).toHaveLength(1);
  expect((await (await f.query()).json()).sessions[0].execution.state).toBe('ready');
  const write=await fetch(`${f.host.url}/api/resources/workspace.text?workspaceId=${env.workspace.id}&path=still-held`,{method:'POST',headers:{'Content-Type':'application/octet-stream',Cookie:f.cookie,Origin:f.host.url,'X-Aork-CSRF':f.bootstrap.access.csrfToken!,'X-Aork-Graph':f.bootstrap.pluginGraphHash},body:'blocked'});expect(write.status).toBe(409);
});

test('cancellation closes response admission before a later public response and old cards stay closed after restart', async () => {
  const { f, interaction } = await open();
  expect((await f.command('sessions.cancelTurn',{turnId:interaction.turnId})).status).toBe(200);
  const response=await f.command('interactions.respond',{interactionId:interaction.id,optionId:'allow-once'});
  expect([200,409]).toContain(response.status);
  await waitFor(()=>detail(f,interaction.id),value=>['cancelled','expired'].includes(value.state));
  expect((await f.command('interactions.respond',{interactionId:interaction.id,optionId:'allow-once'})).status).toBe(409);
  await f.restart();
  expect((await f.command('interactions.respond',{interactionId:interaction.id,optionId:'allow-once'})).status).toBe(409);
});

test('a response queued behind a blocked native writer is never shown sent, and disconnect records uncertainty without resend', async () => {
  const source=agent.replace("import{appendFileSync}from'node:fs';", "import{appendFileSync,existsSync}from'node:fs';import{dirname,join}from'node:path';import{fileURLToPath}from'node:url';")
    .replace("prompt=r;send({id:0", "prompt=r;process.stdin.pause();setInterval(()=>{if(existsSync(join(dirname(fileURLToPath(import.meta.url)),'disconnect')))process.exit(0);},10);send({id:'fill',method:'unknown'+('X'.repeat(400000)),params:{}});send({id:0");
  const {f,env,interaction}=await open(source);const payload={interactionId:interaction.id,optionId:'allow-once'};const id=crypto.randomUUID();
  const receipt=await(await f.command('interactions.respond',payload,id)).json();expect(receipt.result.state).toBe('responding');
  await new Promise(resolve=>setTimeout(resolve,150));expect((await detail(f,interaction.id)).state).toBe('responding');
  await writeFile(join(f.directory,'disconnect'),'disconnect');
  await waitFor(()=>detail(f,interaction.id),value=>value.state==='delivery_unknown');
  expect(await(await f.command('interactions.respond',payload,id)).json()).toEqual(receipt);
  expect((await f.command('interactions.respond',payload)).status).toBe(409);
  expect((await wire(f,env.workspace.directory)).filter(value=>value.id===0&&value.result)).toHaveLength(0);
  await f.restart();expect((await detail(f,interaction.id)).state).toBe('delivery_unknown');
});
