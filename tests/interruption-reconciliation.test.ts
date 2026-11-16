import { afterEach, expect, test } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionEnvironment, sessionHost } from './fixtures/session-host.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const wait = () => new Promise(resolve => setTimeout(resolve, 20));
async function entry(f: Awaited<ReturnType<typeof sessionHost>>, sessionId: string, state: string) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { const item = (await (await f.query()).json()).sessions.find((item: any) => item.session.id === sessionId); if (item?.execution.state === state) return item; await wait(); }
  throw new Error(`Run did not reach ${state}`);
}
async function marker(path: string) { const end = Date.now() + 5000; while (Date.now() < end) { try { return await readFile(path, 'utf8'); } catch { await wait(); } } throw new Error('External fixture did not reach fault boundary'); }
/** Actual ACP process stays alive after losing its Host until its own file gate opens. */
const agent = `import {createInterface} from 'node:readline';import {appendFileSync,writeFileSync,existsSync} from 'node:fs';
if(process.argv[2]==='--version'){console.log('1.2.3');process.exit(0);}
setInterval(()=>{if(existsSync('agent-self-exit'))process.exit(0);},20);
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');process.stdout.on('error',()=>{});
createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);appendFileSync('reconciliation-wire',JSON.stringify(r)+'\\n');
if(r.method==='initialize')send({id:r.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});
if(r.method==='session/new')send({id:r.id,result:{sessionId:'native-reconciliation'}});
if(r.method==='session/prompt')writeFileSync('prompt-attempted','yes');});`;

test('crash retains attempted input and paused queue; check-again never resends and only verified group absence releases its Workspace', async () => {
  const f = await sessionHost(); cleanup.push(() => f.close()); await writeFile(join(f.directory, 'controlled-agent.mjs'), agent);
  const env = await sessionEnvironment(f); cleanup.push(async () => { await writeFile(join(env.workspace.directory, 'agent-self-exit'), 'exit'); await wait(); });
  const session = (await (await f.command('sessions.create', env.input)).json()).result;
  const run = (await (await f.command('sessions.startRun', { sessionId: session.id })).json()).result; await entry(f, session.id, 'ready');
  const first = (await (await f.command('sessions.sendText', { sessionId: session.id, text: 'Preserve original input and link https://example.org/source' })).json()).result;
  await marker(join(env.workspace.directory, 'prompt-attempted'));
  const queued = (await (await f.command('sessions.sendText', { sessionId: session.id, text: 'Do not continue automatically' })).json()).result;
  await f.crashAndRestart(); const unknown = await entry(f, session.id, 'unknown'); expect(unknown.dispatchPaused).toBe(true);
  const timeline = () => fetch(`${f.host.url}/api/resources/sessions.timeline?sessionId=${session.id}`, { headers: { Cookie: f.cookie } }).then(r => r.json());
  expect(await timeline()).toMatchObject({ dispatchPaused: true, turns: [{ id: first.id, state: 'delivery_unknown' }, { id: queued.id, state: 'queued' }] });
  const blockedResponse = await f.command('sessions.recheckRun', { runId: run.runId });
  expect(blockedResponse.status).toBe(200);
  expect((await blockedResponse.json()).result).toMatchObject({ status: 'blocked', reason: 'group-present', coverage: 'complete' });
  const write = () => fetch(`${f.host.url}/api/resources/workspace.text?workspaceId=${env.workspace.id}&path=retained.txt`, { method: 'POST', headers: { 'Content-Type':'application/octet-stream', Cookie: f.cookie, Origin: f.host.url, 'X-Aork-CSRF': f.bootstrap.access.csrfToken!, 'X-Aork-Graph': f.bootstrap.pluginGraphHash }, body: 'write after verification' });
  expect((await write()).status).toBe(409);
  await writeFile(join(env.workspace.directory, 'agent-self-exit'), 'exit');
  const deadline = Date.now() + 5000; let receipt: any;
  while (Date.now() < deadline) { receipt = await (await f.command('sessions.recheckRun', { runId: run.runId })).json(); if (receipt.result?.status === 'verified-stopped') break; await wait(); }
  expect(receipt.result).toMatchObject({ status: 'verified-stopped', reason: 'covered-group-absent' });
  expect((await entry(f, session.id, 'stopped')).dispatchPaused).toBe(true); expect((await write()).status).toBe(200);
  const saved = await timeline(); expect(saved.messages[0].text).toBe('Preserve original input and link https://example.org/source');
  expect((await readFile(join(env.workspace.directory, 'reconciliation-wire'), 'utf8')).split('\n').filter(x => x.includes('session/prompt'))).toHaveLength(1);
  expect((await f.command('sessions.removeQueuedTurn', { turnId: queued.id })).status).toBe(200);
});

test('restart publishes terminal invalidation for both projected permission and form channels and rejects their old responses', async () => {
  const f = await sessionHost(); cleanup.push(() => f.close());
  const requesting = agent.replace("if(r.method==='session/prompt')writeFileSync('prompt-attempted','yes');", `if(r.method==='session/prompt'){writeFileSync('prompt-attempted','yes');send({id:'permission',method:'session/request_permission',params:{sessionId:'native-reconciliation',toolCall:{toolCallId:'write-one',title:'Write retained notes',status:'pending'},options:[{optionId:'allow-once',name:'Allow once',kind:'allow_once'}]}});send({id:'form',method:'elicitation/create',params:{mode:'form',sessionId:'native-reconciliation',message:'Research topic',requestedSchema:{type:'object',properties:{topic:{type:'string'}},required:['topic']}}});}`);
  await writeFile(join(f.directory, 'controlled-agent.mjs'), requesting); const env = await sessionEnvironment(f);
  cleanup.push(async () => { await writeFile(join(env.workspace.directory, 'agent-self-exit'), 'exit'); await wait(); });
  const session = (await (await f.command('sessions.create', env.input)).json()).result;
  await f.command('sessions.startRun', { sessionId: session.id }); await entry(f, session.id, 'ready');
  await f.command('sessions.sendText', { sessionId: session.id, text: 'Retain waiting work' });
  async function pending(name:string) { const end=Date.now()+5000;while(Date.now()<end){const result=await(await f.query(name)).json();if(result.pending?.length)return result.pending[0];await wait();}throw new Error('Pending channel did not appear'); }
  const permission=await pending('interactions.pending'); const form=await pending('interactions.inputPending');
  await f.crashAndRestart();
  expect(await(await f.query('interactions.pending')).json()).toEqual({pending:[]}); expect(await(await f.query('interactions.inputPending')).json()).toEqual({pending:[]});
  expect((await f.command('interactions.respond',{interactionId:permission.id,optionId:'allow-once'})).status).toBe(409);
  expect((await f.command('interactions.submit',{interactionId:form.id,action:'accept',content:{topic:'Never sent'}})).status).toBe(409);
  const events=await(await fetch(`${f.host.url}/api/events?after=0&limit=100`,{headers:{Cookie:f.cookie}})).json();
  for(const id of [permission.id,form.id]) expect(events.events.filter((event:any)=>event.payload.id===id&&['expired','invalidated'].includes(event.payload.state))).toHaveLength(1);
  expect((await readFile(join(env.workspace.directory,'reconciliation-wire'),'utf8')).split('\n').filter(line=>line.includes('"result":{"action":"accept"')||line.includes('"outcome":"selected"'))).toHaveLength(0);
});

test('a missing old leader never authorizes cleanup of its surviving group; unrelated roots stay usable until the fixture child self-exits', async () => {
  const child=`import{existsSync,writeFileSync}from'node:fs';writeFileSync('child-ready','yes');setInterval(()=>{if(existsSync('child-self-exit'))process.exit(0);},20);`;
  const withChild=agent.replace("import {createInterface}","import {spawn} from 'node:child_process';import {createInterface}").replace("if(existsSync('agent-self-exit'))", "if(existsSync('leader-self-exit'))").replace("if(r.method==='session/new')send",`if(r.method==='session/new')spawn(process.execPath,['--input-type=module','-e',${JSON.stringify(child)}],{stdio:'ignore'});if(r.method==='session/new')send`);
  const f=await sessionHost();cleanup.push(()=>f.close());await writeFile(join(f.directory,'controlled-agent.mjs'),withChild);const env=await sessionEnvironment(f);
  cleanup.push(async()=>{await writeFile(join(env.workspace.directory,'leader-self-exit'),'exit');await writeFile(join(env.workspace.directory,'child-self-exit'),'exit');await wait();});
  const session=(await(await f.command('sessions.create',env.input)).json()).result;const run=(await(await f.command('sessions.startRun',{sessionId:session.id})).json()).result;const ready=await entry(f,session.id,'ready');await marker(join(env.workspace.directory,'child-ready'));
  await f.crashAndRestart();await writeFile(join(env.workspace.directory,'leader-self-exit'),'exit');
  const end=Date.now()+5000;while(Date.now()<end){try{process.kill(ready.execution.processIdentity.pid,0);await wait();}catch{break;}}
  expect(()=>process.kill(ready.execution.processIdentity.pid,0)).toThrow();
  expect((await(await f.command('sessions.recheckRun',{runId:run.runId})).json()).result).toMatchObject({status:'blocked',reason:'group-present'});
  expect((await f.command('sessions.startRun',{sessionId:session.id})).status).toBe(409);
  const other=await sessionEnvironment(f);const response=await fetch(`${f.host.url}/api/resources/workspace.text?workspaceId=${other.workspace.id}&path=independent.txt`,{method:'POST',headers:{'Content-Type':'application/octet-stream',Cookie:f.cookie,Origin:f.host.url,'X-Aork-CSRF':f.bootstrap.access.csrfToken!,'X-Aork-Graph':f.bootstrap.pluginGraphHash},body:'unrelated root healthy'});expect(response.status).toBe(200);
  await writeFile(join(env.workspace.directory,'child-self-exit'),'exit');let result:any;const deadline=Date.now()+5000;while(Date.now()<deadline){result=await(await f.command('sessions.recheckRun',{runId:run.runId})).json();if(result.result?.status==='verified-stopped')break;await wait();}expect(result.result).toMatchObject({status:'verified-stopped',reason:'covered-group-absent'});
});

test('recheck is principal-filtered and accepts no browser process identity, owner or confirmation authority; immutable receipts survive restart', async () => {
  const f=await sessionHost(false,async({distributionDir,profile})=>{
    const {mkdir}=await import('node:fs/promises');const plugin=join(distributionDir,'plugins/reconciliation-probe/0.1.0');await mkdir(plugin,{recursive:true});
    await writeFile(join(plugin,'aork.plugin.json'),JSON.stringify({manifestVersion:1,id:'reconciliation-probe',version:'0.1.0',sdkRange:'^0.1.0',server:'server.js',requires:['aork.runtime.reconciliation@1','aork.agent.providers@1'],ui:{providers:[]}}));
    await writeFile(join(plugin,'server.js'),`export function activate(c){c.command('probe.reconcile',{access:'authenticated',async execute(payload,request){const facade=c.service('aork.runtime.reconciliation@1');const metadata=c.service('aork.agent.providers@1').owner('session.test');try{const token=await facade.prepare(payload.runId,request.identity,metadata);return c.transactions.run(tx=>facade.apply(tx,token,metadata));}catch(error){return{denied:error.code};}}});}`);profile.plugins.push({id:'reconciliation-probe',version:'0.1.0',enabled:true});
  });cleanup.push(()=>f.close());await writeFile(join(f.directory,'controlled-agent.mjs'),agent);const env=await sessionEnvironment(f);cleanup.push(async()=>{await writeFile(join(env.workspace.directory,'agent-self-exit'),'exit');await wait();});
  const session=(await(await f.command('sessions.create',env.input)).json()).result;const run=(await(await f.command('sessions.startRun',{sessionId:session.id})).json()).result;await entry(f,session.id,'ready');await f.crashAndRestart();
  for(const extra of [{pid:123},{group:123},{confirmed:true},{owner:'sessions'},{proof:{}}])expect((await f.command('sessions.recheckRun',{runId:run.runId,...extra})).status).toBe(400);
  expect((await f.command('sessions.recheckRun',{runId:crypto.randomUUID()})).status).toBe(404);
  expect(await(await f.command('probe.reconcile',{runId:run.runId})).json()).toEqual({denied:'RECONCILIATION_OWNER_INVALID'});
  const resource=`${f.host.url}/api/snapshots/sessions.reconciliation?runId=${run.runId}`;
  expect((await fetch(resource)).status).toBe(401);expect((await fetch(`${resource}&pid=123`,{headers:{Cookie:f.cookie,'X-Aork-Graph':f.bootstrap.pluginGraphHash}})).status).toBe(400);
  const id=crypto.randomUUID();const receipt=await(await f.command('sessions.recheckRun',{runId:run.runId},id)).json();await f.restart();expect(await(await f.command('sessions.recheckRun',{runId:run.runId},id)).json()).toEqual(receipt);
  expect((await f.command('sessions.recheckRun',{runId:crypto.randomUUID()},id)).status).toBe(409);
  const publicText=JSON.stringify(await(await fetch(resource,{headers:{Cookie:f.cookie,'X-Aork-Graph':f.bootstrap.pluginGraphHash}})).json());for(const privateValue of ['processIdentity','argv','environment','owner','/private/','token','SQL'])expect(publicText).not.toContain(privateValue);
});

test('upgrading a real prior Runtime keeps legacy incomplete coverage blocked even when its recorded group is absent', async () => {
  const {build}=await import('esbuild');const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const {cp}=await import('node:fs/promises');
  let distribution='';
  const f=await sessionHost(false,async({distributionDir})=>{
    distribution=distributionDir;
    // Compile the pinned accepted17 production Runtime as a real installed old
    // package. The upgrade changes artifacts, never business rows or SQL.
    await build({entryPoints:['plugins/runtime-acp/src/server.ts'],outfile:join(distributionDir,'plugins/runtime-acp/0.1.0/server.js'),bundle:true,format:'esm',platform:'node',target:'node24',plugins:[{name:'accepted17-runtime',setup(builder){builder.onLoad({filter:/plugins\/runtime-acp\/src\/.*\.ts$/},async args=>({contents:(await promisify(execFile)('git',['show',`f15e7ef:${args.path.slice(process.cwd().length+1)}`])).stdout,loader:'ts'}));}}]});
    const manifest=JSON.parse((await promisify(execFile)('git',['show','f15e7ef:plugins/runtime-acp/aork.plugin.json'])).stdout);await writeFile(join(distributionDir,'plugins/runtime-acp/0.1.0/aork.plugin.json'),JSON.stringify(manifest));
  });cleanup.push(()=>f.close());await writeFile(join(f.directory,'controlled-agent.mjs'),agent);const env=await sessionEnvironment(f);cleanup.push(async()=>{await writeFile(join(env.workspace.directory,'agent-self-exit'),'exit');await wait();});
  const session=(await(await f.command('sessions.create',env.input)).json()).result;const run=(await(await f.command('sessions.startRun',{sessionId:session.id})).json()).result;await entry(f,session.id,'ready');
  await f.crashAndRestart(false,async()=>{await writeFile(join(env.workspace.directory,'agent-self-exit'),'exit');await cp('dist/plugins/runtime-acp/0.1.0',join(distribution,'plugins/runtime-acp/0.1.0'),{recursive:true});});
  await entry(f,session.id,'unknown');
  const diagnostic=(await(await f.command('sessions.recheckRun',{runId:run.runId})).json()).result;expect(diagnostic).toMatchObject({status:'blocked',reason:'coverage-incomplete',coverage:'unknown'});
  expect((await f.command('sessions.startRun',{sessionId:session.id})).status).toBe(409);
});

test('a committed unprojected permission is invalidated on catch-up without opening a stale response channel', async () => {
  let crashMarker='';const f=await sessionHost(false,async({directory,distributionDir,profile})=>{
    const {mkdir}=await import('node:fs/promises');const id='permission-crash-observer';const plugin=join(distributionDir,'plugins',id,'0.1.0');crashMarker=join(directory,'permission-crash-once');await mkdir(plugin,{recursive:true});
    await writeFile(join(plugin,'aork.plugin.json'),JSON.stringify({manifestVersion:1,id,version:'0.1.0',sdkRange:'^0.1.0',server:'server.js',requires:['aork.runtime.acp@1'],ui:{providers:[]}}));
    await writeFile(join(plugin,'server.js'),`import{existsSync,writeFileSync}from'node:fs';export function activate(c){c.consumeFacts(c.service('aork.runtime.acp@1').permissionFacts,{id:'crashBeforeProjection',events:{},apply(fact){if(fact.payload.interaction.state==='pending'&&!existsSync(${JSON.stringify(crashMarker)})){writeFileSync(${JSON.stringify(crashMarker)},fact.payload.interaction.id,{flag:'wx'});process.kill(process.pid,'SIGKILL');}return{principal:fact.payload.principal,events:[]};}});}`);
    profile.plugins.push({id,version:'0.1.0',enabled:true});const path=join(distributionDir,'plugins/interactions/0.1.0/aork.plugin.json');const manifest=JSON.parse(await readFile(path,'utf8'));manifest.dependencies=[...(manifest.dependencies??[]),{id,range:'^0.1.0'}];await writeFile(path,JSON.stringify(manifest));
  });cleanup.push(()=>f.close());
  await writeFile(join(f.directory,'controlled-agent.mjs'),agent.replace("if(r.method==='session/prompt')writeFileSync('prompt-attempted','yes');", "if(r.method==='session/prompt')send({id:'permission',method:'session/request_permission',params:{sessionId:'native-reconciliation',toolCall:{toolCallId:'write-one',title:'Permission before projection',status:'pending'},options:[{optionId:'allow',name:'Allow',kind:'allow_once'}]}});"));
  const env=await sessionEnvironment(f);cleanup.push(async()=>{await writeFile(join(env.workspace.directory,'agent-self-exit'),'exit');await wait();});const session=(await(await f.command('sessions.create',env.input)).json()).result;await f.command('sessions.startRun',{sessionId:session.id});await entry(f,session.id,'ready');await f.command('sessions.sendText',{sessionId:session.id,text:'Fault after committed permission'});const id=await marker(crashMarker);await f.crashAndRestart();
  expect(await(await f.query('interactions.pending')).json()).toEqual({pending:[]});expect((await(await f.query('interactions.history')).json()).interactions).toEqual([expect.objectContaining({id,state:'invalidated'})]);
  expect((await f.command('interactions.respond',{interactionId:id,optionId:'allow'})).status).toBe(409);
  const events=await(await fetch(`${f.host.url}/api/events?after=0&limit=100`,{headers:{Cookie:f.cookie}})).json();expect(events.events.filter((event:any)=>event.payload.id===id).map((event:any)=>event.payload.state)).toEqual(['invalidated']);
});

test('checking saved confirmed stopped history while Runtime is disabled never re-blocks an already released Workspace',async()=>{
  const f=await sessionHost();cleanup.push(()=>f.close());await writeFile(join(f.directory,'controlled-agent.mjs'),agent);const env=await sessionEnvironment(f);const session=(await(await f.command('sessions.create',env.input)).json()).result;const run=(await(await f.command('sessions.startRun',{sessionId:session.id})).json()).result;await entry(f,session.id,'ready');await f.command('sessions.endRun',{runId:run.runId});await entry(f,session.id,'stopped');await f.crashAndRestart(true);
  expect((await(await f.command('sessions.recheckRun',{runId:run.runId})).json()).result).toMatchObject({status:'verified-stopped',reason:'managed-stop-confirmed'});
  expect((await fetch(`${f.host.url}/api/resources/workspace.text?workspaceId=${env.workspace.id}&path=still-available.txt`,{method:'POST',headers:{'Content-Type':'application/octet-stream',Cookie:f.cookie,Origin:f.host.url,'X-Aork-CSRF':f.bootstrap.access.csrfToken!,'X-Aork-Graph':f.bootstrap.pluginGraphHash},body:'still released'})).status).toBe(200);
});
