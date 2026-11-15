import { afterEach, expect, test } from 'vitest';
import { writeFile, readFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionEnvironment, sessionHost } from './fixtures/session-host.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function ready(f: Awaited<ReturnType<typeof sessionHost>>, state: string, sessionId?:string) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await (await f.query()).json();
    const entry=value.sessions?.find((entry:{session:{id:string}})=>!sessionId||entry.session.id===sessionId);if(entry?.execution?.state===state)return entry;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Run did not reach ${state}: ${JSON.stringify(await (await f.query()).json())}`);
}
const agent = `import { writeFileSync, appendFileSync } from 'node:fs'; import { createInterface } from 'node:readline';
if (process.argv[2] === '--version') { console.log('1.2.3'); process.exit(0); }
const lines = createInterface({ input: process.stdin });
for await (const line of lines) { const request = JSON.parse(line); appendFileSync('agent-requests',request.method+'\\n'); let result;
if (request.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: { loadSession: false }, agentInfo: { name: 'controlled-acp', version: '1.2.3' }, authMethods: [] };
else if (request.method === 'session/new') { writeFileSync('agent-evidence.json', JSON.stringify({cwd:process.cwd(),environment:Object.keys(process.env).sort(),method:request.method})); result = { sessionId: 'native-controlled' }; }
else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: {code:-32601,message:'unsupported'} })+'\\n'); continue; }
process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result })+'\\n'); }
`;
test('accepted Run reaches ACP ready, retains Workspace ownership and ends before another file writer enters', async () => {
  const f = await sessionHost(); cleanup.push(() => f.close());
  await writeFile(join(f.directory, 'controlled-agent.mjs'), agent);
  const env = await sessionEnvironment(f);
  const session = (await (await f.command('sessions.create', env.input)).json()).result;
  const id = crypto.randomUUID();
  const starts=await Promise.all([f.command('sessions.startRun',{sessionId:session.id},id),f.command('sessions.startRun',{sessionId:session.id},id)]);
  expect(starts.map(response=>response.status)).toEqual([200,200]);const started=starts[0]!;
  const receipt = await started.json(); expect(receipt.result.state).toBe('starting');
  expect(await (await f.command('sessions.startRun', { sessionId: session.id }, id)).json()).toEqual(receipt);
  expect(await starts[1]!.json()).toEqual(receipt);
  const conflict=await f.command('sessions.startRun',{sessionId:crypto.randomUUID()},id);expect(conflict.status).toBe(409);expect(await conflict.json()).toMatchObject({error:{code:'COMMAND_ID_CONFLICT'}});
  const entry = await ready(f, 'ready');
  expect(JSON.parse(await readFile(join(env.workspace.directory,'agent-evidence.json'),'utf8'))).toEqual({cwd:env.workspace.directory,environment:process.platform==='darwin'?['LANG','PATH','__CF_USER_TEXT_ENCODING']:['LANG','PATH'],method:'session/new'});
  expect(entry.execution.runtime).toMatchObject({nodeVersion:'24.22.3',acpSdkVersion:'2.7.0',platform:process.platform});expect(entry.execution.processIdentity.pid).toBeGreaterThan(0);expect(entry.execution.processIdentity.group).toBe(entry.execution.processIdentity.pid);
  expect(entry.execution).toMatchObject({ runId: receipt.result.runId, nativeSessionId: 'native-controlled', protocolVersion: 1, agentVersion: '1.2.3', loadSession: false, directory: env.workspace.directory });
  const write = () => fetch(`${f.host.url}/api/resources/workspace.text?workspaceId=${env.workspace.id}&path=output.txt`, {method:'POST',headers:{'Content-Type':'application/octet-stream',Cookie:f.cookie,Origin:f.host.url,'X-Aork-CSRF':f.bootstrap.access.csrfToken!,'X-Aork-Graph':f.bootstrap.pluginGraphHash},body:'accepted'});
  expect((await write()).status).toBe(409);
  expect((await f.command('sessions.endRun', { runId: receipt.result.runId })).status).toBe(200);
  await ready(f, 'stopped');
  const written=await write();expect(await written.json()).not.toHaveProperty('error');expect(written.status).toBe(200);
  await writeFile(join(f.directory,'controlled-agent.mjs'),agent.replace("agentInfo: { name: 'controlled-acp', version: '1.2.3' }, ",''));expect((await f.command('sessions.startRun',{sessionId:session.id})).status).toBe(200);const noReportedVersion=await ready(f,'ready');expect(noReportedVersion.execution.detectedVersion).toBe('1.2.3');expect(noReportedVersion.execution).not.toHaveProperty('agentVersion');expect(noReportedVersion.execution).not.toHaveProperty('agentName');expect((await f.command('sessions.endRun',{runId:noReportedVersion.execution.runId})).status).toBe(200);await ready(f,'stopped');
});

test('ready Run is stopped on Host close, durable facts project once after restart and no new Agent is dispatched', async()=>{
  const f=await sessionHost();cleanup.push(()=>f.close());await writeFile(join(f.directory,'controlled-agent.mjs'),agent);
  const env=await sessionEnvironment(f);const session=(await(await f.command('sessions.create',env.input)).json()).result;
  expect((await f.command('sessions.startRun',{sessionId:session.id})).status).toBe(200);await ready(f,'ready');
  await f.restart();await ready(f,'stopped');
  const events=await(await fetch(`${f.host.url}/api/events?after=0&limit=100`,{headers:{Cookie:f.cookie}})).json();
  expect(events.events.filter((event:{type:string;payload:{state?:string}})=>event.type==='sessions.runChanged').map((event:{payload:{state:string}})=>event.payload.state)).toEqual(['starting','ready','stopped']);
  await f.restart();await ready(f,'stopped');
  const again=await(await fetch(`${f.host.url}/api/events?after=0&limit=100`,{headers:{Cookie:f.cookie}})).json();expect(again.events).toEqual(events.events);
});

test('Host close aborts a hanging initialize and confirms process stop before releasing its Workspace after restart',async()=>{
  const f=await sessionHost();cleanup.push(()=>f.close());
  await writeFile(join(f.directory,'controlled-agent.mjs'),agent.replace("if (request.method === 'initialize') result", "if (request.method === 'initialize') {writeFileSync('initialize-attempted','yes');await new Promise(()=>{});} if (request.method === 'initialize') result"));
  const env=await sessionEnvironment(f);const session=(await(await f.command('sessions.create',env.input)).json()).result;
  expect((await f.command('sessions.startRun',{sessionId:session.id})).status).toBe(200);
  const deadline=Date.now()+5000;while(Date.now()<deadline){try{await readFile(join(env.workspace.directory,'initialize-attempted'));break;}catch{await new Promise(resolve=>setTimeout(resolve,20));}}
  expect(await readFile(join(env.workspace.directory,'initialize-attempted'),'utf8')).toBe('yes');
  await f.restart();await ready(f,'stopped');
});

test('incompatible ACP protocol is rejected before native Session creation and its confirmed process stop releases the Claim',async()=>{
  const f=await sessionHost();cleanup.push(()=>f.close());await writeFile(join(f.directory,'controlled-agent.mjs'),agent.replace('protocolVersion: 1','protocolVersion: 999'));
  const env=await sessionEnvironment(f);const session=(await(await f.command('sessions.create',env.input)).json()).result;
  expect((await f.command('sessions.startRun',{sessionId:session.id})).status).toBe(200);await ready(f,'stopped');
  await expect(readFile(join(env.workspace.directory,'agent-evidence.json'))).rejects.toHaveProperty('code','ENOENT');
});

test('physical aliases, ancestors and descendants exclude other Runs while unrelated directories remain usable',async()=>{
  const f=await sessionHost();cleanup.push(()=>f.close());await writeFile(join(f.directory,'controlled-agent.mjs'),agent);
  const env=await sessionEnvironment(f);const session=(await(await f.command('sessions.create',env.input)).json()).result;
  const second=(await(await f.command('sessions.create',{...env.input,name:'Concurrent'})).json()).result;
  const starts=await Promise.all([f.command('sessions.startRun',{sessionId:session.id}),f.command('sessions.startRun',{sessionId:second.id})]);expect(starts.map(r=>r.status).sort()).toEqual([200,409]);
  const winner=starts[0]!.status===200?session:second;const accepted=await starts.find(r=>r.status===200)!.json();await ready(f,'ready',winner.id);
  await symlink(env.workspace.directory,join(f.directory,'root-alias'));await mkdir(join(env.workspace.directory,'nested'));
  for(const directory of [join(f.directory,'root-alias'),join(env.workspace.directory,'nested'),join(env.workspace.directory,'..')]){
    const workspace=(await(await f.command('workspace.create',{projectId:env.project.id,workspace:{name:'Overlapping',management:'external',directory,access:'read-write'}})).json()).result;
    const sibling=(await(await f.command('sessions.create',{...env.input,workspaceId:workspace.id})).json()).result;
    expect((await f.command('sessions.startRun',{sessionId:sibling.id})).status).toBe(409);
  }
  const other=await sessionEnvironment(f);const otherSession=(await(await f.command('sessions.create',other.input)).json()).result;expect((await f.command('sessions.startRun',{sessionId:otherSession.id})).status).toBe(200);await ready(f,'ready',otherSession.id);
  expect((await f.command('sessions.endRun',{runId:accepted.result.runId})).status).toBe(200);await ready(f,'stopped',winner.id);await ready(f,'ready',otherSession.id);
});

test('used Provider and lifecycle owners cannot change during a Run, pure UI composition preserves it and idle reactivation still works',async()=>{
  const f=await sessionHost();cleanup.push(()=>f.close());await writeFile(join(f.directory,'controlled-agent.mjs'),agent);
  const env=await sessionEnvironment(f);const session=(await(await f.command('sessions.create',env.input)).json()).result;
  // Different manifest profile selection forces genuine idle server reactivation.
  expect((await f.command('plugins.configure',{pluginId:'workspace',config:{}})).status).toBe(200);await f.refreshBootstrap();
  const started=await(await f.command('sessions.startRun',{sessionId:session.id})).json();await ready(f,'ready');
  for(const pluginId of ['session-test-agent','runner-local','runtime-acp','agent-profiles'])expect((await f.command('plugins.configure',{pluginId,config:{}})).status).toBe(409);
  const ui=structuredClone(f.bootstrap.ui);ui.fallbacks={...ui.fallbacks,'aork.sessions.detail@1':'sessions:detail'};
  expect((await f.command('plugins.compose',{ui})).status).toBe(200);await f.refreshBootstrap();await ready(f,'ready');
  expect((await f.command('sessions.endRun',{runId:started.result.runId})).status).toBe(200);await ready(f,'stopped');
  expect((await f.command('plugins.configure',{pluginId:'session-test-agent',config:{}})).status).toBe(200);await f.refreshBootstrap();
});

test('crash fences an uncertain generation without replay or old-PID stop, and unknown Claims still protect Files when Runtime is removed',async()=>{
  const f=await sessionHost();cleanup.push(()=>f.close());await writeFile(join(f.directory,'controlled-agent.mjs'),agent);
  const env=await sessionEnvironment(f);const session=(await(await f.command('sessions.create',env.input)).json()).result;
  const started=await(await f.command('sessions.startRun',{sessionId:session.id})).json();await ready(f,'ready');
  const requests=await readFile(join(env.workspace.directory,'agent-requests'),'utf8');expect(requests).toBe('initialize\nsession/new\n');
  await f.crashAndRestart();const unknown=await ready(f,'unknown');expect(unknown.execution.runId).toBe(started.result.runId);
  expect((await f.command('sessions.endRun',{runId:started.result.runId})).status).toBe(409);expect((await f.command('sessions.archive',{id:session.id})).status).toBe(409);expect((await f.command('sessions.startRun',{sessionId:session.id})).status).toBe(409);
  expect(await readFile(join(env.workspace.directory,'agent-requests'),'utf8')).toBe(requests);
  await f.crashAndRestart(true);expect((await f.query()).status).toBe(200);await ready(f,'unknown');
  const write=(id:string)=>fetch(`${f.host.url}/api/resources/workspace.text?workspaceId=${id}&path=after-crash.txt`,{method:'POST',headers:{'Content-Type':'application/octet-stream',Cookie:f.cookie,Origin:f.host.url,'X-Aork-CSRF':f.bootstrap.access.csrfToken!,'X-Aork-Graph':f.bootstrap.pluginGraphHash},body:'safe'});
  const blocked=await write(env.workspace.id);expect(blocked.status).toBe(409);expect(await blocked.json()).toMatchObject({error:{code:'WORKSPACE_WRITER_UNKNOWN'}});
  const other=(await(await f.command('workspace.createProject',{name:'Unrelated',workspace:{name:'Available',management:'managed'}})).json()).result;expect((await write(other.workspace.id)).status).toBe(200);
});

test('an independent Runtime consumer cannot forge a stopped fact or borrow another Provider owner to bypass its live-use gate',async()=>{
  const f=await sessionHost(false,async({distributionDir,profile})=>{
    const directory=join(distributionDir,'plugins/ownership-probe/0.1.0');await mkdir(directory,{recursive:true});
    await writeFile(join(directory,'aork.plugin.json'),JSON.stringify({manifestVersion:1,id:'ownership-probe',version:'0.1.0',sdkRange:'^0.1.0',server:'server.js',requires:['aork.runtime.acp@1','aork.agent.providers@1','aork.agent.profiles@1','aork.workspace@1'],ui:{providers:[]}}));
    await writeFile(join(directory,'server.js'),`export function activate(c){const registry=c.service('aork.agent.providers@1');const runtime=c.service('aork.runtime.acp@1');const provider=registry.get('session.test');const metadata=registry.owner('session.test');registry.register({...provider,id:'ownership.probe',label:'Owned probe'},metadata);c.query('probe.owner',{access:'authenticated',execute(){let verified=false;try{c.verifyOwner(metadata);verified=true;}catch{}let mutable=false;try{c.owner.grants.push('process.spawn');mutable=true;}catch{}return{owner:registry.owner('ownership.probe'),verified,mutable};}});c.command('probe.splitPermit',{access:'authenticated',execute(payload){const ws=c.service('aork.workspace@1');return ws.withWritePermission(payload.workspaceId,async()=>{const runId=crypto.randomUUID();const permit=c.transactions.run(tx=>ws.reserveClaim(tx,c.owner,runId,payload.workspaceId,[c.pluginId]));let result;try{c.transactions.run(tx=>ws.verifyClaim(tx,permit,c.owner,runId,payload.workspaceId));result={accepted:true};}catch(error){result={accepted:false,code:error.code};}finally{c.transactions.run(tx=>ws.releaseClaim(tx,c.owner,runId));}return result;});}});c.command('probe.noGate',{access:'authenticated',execute(payload){try{c.transactions.run(tx=>c.service('aork.workspace@1').reserveClaim(tx,c.owner,payload.runId,payload.workspaceId,[c.pluginId]));return{accepted:true};}catch(error){return{accepted:false,code:error.code};}}});c.command('probe.noClaim',{access:'authenticated',async execute(payload,request){const agent=await c.service('aork.agent.profiles@1').prepareLaunch(payload.profile);try{c.transactions.run(tx=>runtime.acceptStart(tx,{run:payload.run,workspace:payload.workspace,agent,owner:c.owner,principal:request.identity,claim:{}}));return{accepted:true};}catch(error){return{accepted:false,code:error.code};}}});c.command('probe.forgeStopped',{access:'authenticated',execute(payload){if(typeof runtime.facts.append!=='function')return{forged:false};c.transactions.run(tx=>runtime.facts.append(tx,payload.runId,{...payload,state:'stopped'}));return{forged:true};}});}`);
    profile.plugins.push({id:'ownership-probe',version:'0.1.0',enabled:true});
  });cleanup.push(()=>f.close());await writeFile(join(f.directory,'controlled-agent.mjs'),agent);
  expect(await(await f.query('probe.owner')).json()).toEqual({owner:{pluginId:'ownership-probe',version:'0.1.0'},verified:false,mutable:false});
  const env=await sessionEnvironment(f);const profile=(await(await f.command('agents.createProfile',{name:'Probe profile',providerId:'ownership.probe',parameters:{model:'controlled-model'},versionRequirement:'^1.0.0',authentication:'none'})).json()).result;
  const session=(await(await f.command('sessions.create',{...env.input,profileId:profile.id})).json()).result;const started=await(await f.command('sessions.startRun',{sessionId:session.id})).json();const entry=await ready(f,'ready');
  expect(entry.execution.usedPluginIds).toContain('ownership-probe');expect((await f.command('plugins.configure',{pluginId:'ownership-probe',config:{}})).status).toBe(409);expect((await f.command('plugins.setEnabled',{pluginId:'ownership-probe',enabled:false})).status).toBe(409);
  expect(await(await f.command('probe.forgeStopped',{runId:entry.execution.runId,generation:entry.execution.generation,hostEpoch:entry.execution.hostEpoch})).json()).toEqual({forged:false});await ready(f,'ready');expect(()=>process.kill(entry.execution.processIdentity.pid,0)).not.toThrow();
  const freshWorkspace=(await(await f.command('workspace.create',{projectId:env.project.id,workspace:{name:'Atomic proof check',management:'managed'}})).json()).result;expect(await(await f.command('probe.splitPermit',{workspaceId:freshWorkspace.id})).json()).toEqual({accepted:false,code:'CLAIM_ADMISSION_INVALID'});
  expect(await(await f.command('probe.noGate',{runId:crypto.randomUUID(),workspaceId:env.workspace.id})).json()).toEqual({accepted:false,code:'WORKSPACE_ADMISSION_REQUIRED'});
  expect(await(await f.command('probe.noClaim',{profile:session.profile,run:{...entry.execution,runId:crypto.randomUUID(),state:'starting'},workspace:env.workspace})).json()).toEqual({accepted:false,code:'CLAIM_ADMISSION_INVALID'});await ready(f,'ready');
  const write=await fetch(`${f.host.url}/api/resources/workspace.text?workspaceId=${env.workspace.id}&path=forged.txt`,{method:'POST',headers:{'Content-Type':'application/octet-stream',Cookie:f.cookie,Origin:f.host.url,'X-Aork-CSRF':f.bootstrap.access.csrfToken!,'X-Aork-Graph':f.bootstrap.pluginGraphHash},body:'unsafe'});expect(write.status).toBe(409);
  expect((await f.command('sessions.endRun',{runId:started.result.runId})).status).toBe(200);await ready(f,'stopped');
});

test('setup RPC failures and stop during session creation never release before actual process cleanup',async()=>{
  for(const method of ['initialize','session/new']){
    const f=await sessionHost();cleanup.push(()=>f.close());
    const failure=agent.replace('let result;',`let result;if(request.method===${JSON.stringify(method)}){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32000,message:'private-adapter-detail-must-not-leak'}})+'\\n');continue;}`);
    await writeFile(join(f.directory,'controlled-agent.mjs'),failure);const env=await sessionEnvironment(f);const session=(await(await f.command('sessions.create',env.input)).json()).result;
    expect((await f.command('sessions.startRun',{sessionId:session.id})).status).toBe(200);await ready(f,'stopped');expect(JSON.stringify(await(await f.query()).json())).not.toContain('private-adapter-detail-must-not-leak');
    await f.close();cleanup.pop();
  }
  const f=await sessionHost();cleanup.push(()=>f.close());await writeFile(join(f.directory,'controlled-agent.mjs'),agent.replace("else if (request.method === 'session/new') {", "else if (request.method === 'session/new') {writeFileSync('new-attempted','yes');await new Promise(()=>{});"));
  const env=await sessionEnvironment(f);const session=(await(await f.command('sessions.create',env.input)).json()).result;const started=await(await f.command('sessions.startRun',{sessionId:session.id})).json();
  const deadline=Date.now()+5000;while(Date.now()<deadline){try{await readFile(join(env.workspace.directory,'new-attempted'));break;}catch{await new Promise(resolve=>setTimeout(resolve,20));}}
  expect(await readFile(join(env.workspace.directory,'new-attempted'),'utf8')).toBe('yes');expect((await f.command('sessions.endRun',{runId:started.result.runId})).status).toBe(200);await ready(f,'stopped');
});

test('saved Profile revisions are enforced and resolved Host secrets never enter the child or durable Run projection',async()=>{
  const secret=`host-secret-${crypto.randomUUID()}`;const previous=process.env.AORK_SYNTHETIC_SECRET;process.env.AORK_SYNTHETIC_SECRET=secret;
  const f=await sessionHost();if(previous===undefined)delete process.env.AORK_SYNTHETIC_SECRET;else process.env.AORK_SYNTHETIC_SECRET=previous;cleanup.push(()=>f.close());await writeFile(join(f.directory,'controlled-agent.mjs'),agent);
  const env=await sessionEnvironment(f);const old=(await(await f.command('sessions.create',env.input)).json()).result;
  const {id,revision,stateDirectory:_state,...input}=env.profile;expect((await f.command('agents.editProfile',{...input,id,expectedRevision:revision,parameters:{model:'changed-model'}})).status).toBe(200);
  const commandId=crypto.randomUUID();const rejected=await f.command('sessions.startRun',{sessionId:old.id},commandId);expect(rejected.status).toBe(409);expect(await rejected.json()).toMatchObject({error:{code:'PROFILE_REVISION_CHANGED'}});expect((await fetch(`${f.host.url}/api/receipts/${commandId}`,{headers:{Cookie:f.cookie}})).status).toBe(404);
  const current=(await(await f.command('sessions.create',{...env.input,name:'Current revision'})).json()).result;const started=await(await f.command('sessions.startRun',{sessionId:current.id})).json();const entry=await ready(f,'ready',current.id);expect(entry.execution.profileRevision).toBe(2);
  const evidence=JSON.parse(await readFile(join(env.workspace.directory,'agent-evidence.json'),'utf8'));expect(evidence.environment).not.toContain('AORK_SYNTHETIC_SECRET');expect(evidence.environment).not.toContain('HOME');expect(evidence.environment).not.toContain('CODEX_HOME');
  const {readdir}=await import('node:fs/promises');async function absent(directory:string){for(const entry of await readdir(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())await absent(path);else expect((await readFile(path)).includes(Buffer.from(secret))).toBe(false);}}await absent(f.options.dataDir);
  expect((await f.command('sessions.endRun',{runId:started.result.runId})).status).toBe(200);await ready(f,'stopped',current.id);
});

test('an actual SQLite write failure rejects receipts without leaking payloads and leaves uncertain execution blocked after restart',async()=>{
  const f=await sessionHost(false,async({distributionDir,profile})=>{
    const directory=join(distributionDir,'plugins/storage-failure/0.1.0');await mkdir(directory,{recursive:true});
    await writeFile(join(directory,'aork.plugin.json'),JSON.stringify({manifestVersion:1,id:'storage-failure',version:'0.1.0',sdkRange:'^0.1.0',server:'server.js',ui:{providers:[]}}));
    await writeFile(join(directory,'server.js'),`export const persistence={namespace:'plugin_storage_hfailure__',migrations:[{version:1,statements:['CREATE TABLE plugin_storage_hfailure__fault (id TEXT PRIMARY KEY)']}],statements:{insert:{sql:'INSERT INTO plugin_storage_hfailure__fault (id) VALUES (?)',mode:'write'},records:{sql:'SELECT id FROM plugin_storage_hfailure__fault',mode:'read'}}};export function activate(c){c.query('fault.records',{access:'authenticated',execute:()=>c.repository.all('records')});c.command('fault.async',{access:'authenticated',execute(){try{c.transactions.run(async tx=>{await Promise.resolve();c.repository.run(tx,'insert',['late-write']);});return{accepted:true};}catch(error){return{accepted:false,code:error.code};}}});c.durableCommand('fault.storage',{version:1,payload:{parse:v=>v},result:{parse:v=>v},events:{},execute(v,p,tx){c.repository.run(tx,'insert',['duplicate']);c.repository.run(tx,'insert',['duplicate']);return{result:{accepted:true},events:[]};}});}`);
    profile.plugins.push({id:'storage-failure',version:'0.1.0',enabled:true});
  });cleanup.push(()=>f.close());await writeFile(join(f.directory,'controlled-agent.mjs'),agent);
  const env=await sessionEnvironment(f);const session=(await(await f.command('sessions.create',env.input)).json()).result;const started=await(await f.command('sessions.startRun',{sessionId:session.id})).json();await ready(f,'ready');
  expect(await(await f.command('fault.async',{})).json()).toEqual({accepted:false,code:'TRANSACTION_ASYNC'});expect(await(await f.query('fault.records')).json()).toEqual([]);
  const secret=`uncommitted-secret-${crypto.randomUUID()}`;const commandId=crypto.randomUUID();const failed=await f.command('fault.storage',{secret},commandId);expect(failed.status).toBe(503);expect(await failed.text()).not.toContain(secret);
  expect((await fetch(`${f.host.url}/api/receipts/${commandId}`,{headers:{Cookie:f.cookie}})).status).toBe(404);expect((await f.command('sessions.endRun',{runId:started.result.runId})).status).toBe(503);
  const events=await(await fetch(`${f.host.url}/api/events?after=0&limit=100`,{headers:{Cookie:f.cookie}})).text();expect(events).not.toContain(secret);
  await f.restart();await ready(f,'unknown');expect((await f.command('sessions.startRun',{sessionId:session.id})).status).toBe(409);
});

test('a delayed actual Files upload and Run acceptance use the same gate around the short Claim commit',async()=>{
  const f=await sessionHost(false,async({directory,hostArguments})=>{
    const preload=join(directory,'slow-files.mjs');hostArguments.push('--import',preload);
    await writeFile(preload,`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const release=${JSON.stringify(join(directory,'release'))};const original=fs.promises.open;fs.promises.open=async function(...args){const handle=await original.apply(this,args);if(String(args[0]).includes('.aork-upload-')){const sync=handle.sync.bind(handle);handle.sync=async()=>{await fs.promises.writeFile(${JSON.stringify(join(directory,'upload-waiting'))},'waiting');while(true){try{await fs.promises.access(release);break;}catch(error){if(error.code!=='ENOENT')throw error;await new Promise(resolve=>setTimeout(resolve,20));}}return sync();};}return handle;};syncBuiltinESMExports();`);
  });cleanup.push(()=>f.close());await writeFile(join(f.directory,'controlled-agent.mjs'),agent);const env=await sessionEnvironment(f);const session=(await(await f.command('sessions.create',env.input)).json()).result;
  const headers={'Content-Type':'application/octet-stream',Cookie:f.cookie,Origin:f.host.url,'X-Aork-CSRF':f.bootstrap.access.csrfToken!,'X-Aork-Graph':f.bootstrap.pluginGraphHash};
  const pending=Promise.allSettled([fetch(`${f.host.url}/api/resources/workspace.file?workspaceId=${env.workspace.id}&path=delayed.txt`,{method:'POST',headers,body:'actual delayed upload'})]);
  try{
    const deadline=Date.now()+5000;while(Date.now()<deadline){try{await readFile(join(f.directory,'upload-waiting'));break;}catch{await new Promise(resolve=>setTimeout(resolve,20));}}
    expect(await readFile(join(f.directory,'upload-waiting'),'utf8')).toBe('waiting');
    const commandId=crypto.randomUUID();expect((await f.command('sessions.startRun',{sessionId:session.id},commandId)).status).toBe(409);expect((await fetch(`${f.host.url}/api/receipts/${commandId}`,{headers:{Cookie:f.cookie}})).status).toBe(404);
    expect((await f.query('workspace.overview')).status).toBe(200);
  }finally{await writeFile(join(f.directory,'release'),'go');await pending;}
  const upload=(await pending)[0]!;expect(upload.status).toBe('fulfilled');if(upload.status==='fulfilled')expect(upload.value.status).toBe(200);expect(await readFile(join(env.workspace.directory,'delayed.txt'),'utf8')).toBe('actual delayed upload');
  expect((await f.command('sessions.startRun',{sessionId:session.id})).status).toBe(200);await ready(f,'ready');expect((await fetch(`${f.host.url}/api/resources/workspace.file?workspaceId=${env.workspace.id}&path=after.txt`,{method:'POST',headers,body:'must not enter'})).status).toBe(409);
});

test('Host shutdown joins an automatic stop already escalated after Agent connection loss and persists its terminal fact',async()=>{
  const f=await sessionHost();cleanup.push(()=>f.close());
  const automatic=agent.replace('writeFileSync, appendFileSync','writeFileSync, appendFileSync, existsSync').replace('const lines = createInterface',"let closed=false;process.on('SIGTERM',()=>writeFileSync('automatic-stop-term','received'));setInterval(()=>{if(!closed&&existsSync('close-agent-stdout')){closed=true;process.stdout.end();}},20);const lines = createInterface");
  await writeFile(join(f.directory,'controlled-agent.mjs'),automatic);const env=await sessionEnvironment(f);const session=(await(await f.command('sessions.create',env.input)).json()).result;
  expect((await f.command('sessions.startRun',{sessionId:session.id})).status).toBe(200);const entry=await ready(f,'ready');await writeFile(join(env.workspace.directory,'close-agent-stdout'),'close');
  const deadline=Date.now()+5000;while(Date.now()<deadline){try{await readFile(join(env.workspace.directory,'automatic-stop-term'));break;}catch{await new Promise(resolve=>setTimeout(resolve,20));}}
  expect(await readFile(join(env.workspace.directory,'automatic-stop-term'),'utf8')).toBe('received');expect(()=>process.kill(entry.execution.processIdentity.pid,0)).not.toThrow();
  await f.restart();const stopped=await ready(f,'stopped');expect(stopped.execution.runId).toBe(entry.execution.runId);
});

test('a dependent Plugin may join shutdown without replacing Runtime-owned terminal persistence',async()=>{
  const f=await sessionHost(false,async({distributionDir,profile})=>{const directory=join(distributionDir,'plugins/shutdown-dependent/0.1.0');await mkdir(directory,{recursive:true});await writeFile(join(directory,'aork.plugin.json'),JSON.stringify({manifestVersion:1,id:'shutdown-dependent',version:'0.1.0',sdkRange:'^0.1.0',server:'server.js',requires:['aork.runtime.acp@1'],ui:{providers:[]}}));await writeFile(join(directory,'server.js'),`export function activate(c){const runtime=c.service('aork.runtime.acp@1');c.effect(()=>()=>runtime.shutdown());}`);profile.plugins.push({id:'shutdown-dependent',version:'0.1.0',enabled:true});});cleanup.push(()=>f.close());await writeFile(join(f.directory,'controlled-agent.mjs'),agent);
  const env=await sessionEnvironment(f);const session=(await(await f.command('sessions.create',env.input)).json()).result;expect((await f.command('sessions.startRun',{sessionId:session.id})).status).toBe(200);const before=await ready(f,'ready');await f.restart();const after=await ready(f,'stopped');expect(after.execution.runId).toBe(before.execution.runId);expect(()=>process.kill(-before.execution.processIdentity.group,0)).toThrowError();
  const write=await fetch(`${f.host.url}/api/resources/workspace.text?workspaceId=${env.workspace.id}&path=after-dependent-stop.txt`,{method:'POST',headers:{'Content-Type':'application/octet-stream',Cookie:f.cookie,Origin:f.host.url,'X-Aork-CSRF':f.bootstrap.access.csrfToken!,'X-Aork-Graph':f.bootstrap.pluginGraphHash},body:'released after actual stop'});expect(write.status).toBe(200);
});

test('checking a lifecycle change does not abort an already admitted ACP initialize before its busy refusal',async()=>{
  const f=await sessionHost(false,async({distributionDir,profile})=>{const directory=join(distributionDir,'plugins/early-guard/0.1.0');await mkdir(directory,{recursive:true});await writeFile(join(directory,'aork.plugin.json'),JSON.stringify({manifestVersion:1,id:'early-guard',version:'0.1.0',sdkRange:'^0.1.0',server:'server.js',ui:{providers:[]}}));await writeFile(join(directory,'server.js'),`export function activate(c){let held=false,release;c.lifecycleGuard({acquireChange(ids){if(!ids.includes('runtime-acp'))return{state:'idle',release(){}};held=true;return new Promise(resolve=>{release=()=>{held=false;resolve({state:'idle',release(){}});};});}});c.query('guard.state',{access:'authenticated',execute:()=>({held})});c.command('guard.release',{access:'authenticated',execute(){release?.();return{released:true};}});}`);profile.plugins.unshift({id:'early-guard',version:'0.1.0',enabled:true});});cleanup.push(()=>f.close());
  const delayed=agent.replace('writeFileSync, appendFileSync','writeFileSync, appendFileSync, existsSync').replace("if (request.method === 'initialize') result", "if(request.method==='initialize'){writeFileSync('initialize-wait',String(process.pid));while(!existsSync('release-initialize'))await new Promise(resolve=>setTimeout(resolve,20));} if (request.method === 'initialize') result");await writeFile(join(f.directory,'controlled-agent.mjs'),delayed);
  const env=await sessionEnvironment(f);const session=(await(await f.command('sessions.create',env.input)).json()).result;const started=await(await f.command('sessions.startRun',{sessionId:session.id})).json();
  async function marker(name:string){const deadline=Date.now()+5000;while(Date.now()<deadline){try{return await readFile(join(env.workspace.directory,name),'utf8');}catch{await new Promise(resolve=>setTimeout(resolve,20));}}throw new Error(`Agent did not publish ${name}`);}
  const pid=Number(await marker('initialize-wait'));const changing=Promise.allSettled([f.command('plugins.configure',{pluginId:'runtime-acp',config:{}})]);
  try{const deadline=Date.now()+5000;while(Date.now()<deadline){if((await(await f.query('guard.state')).json()).held)break;await new Promise(resolve=>setTimeout(resolve,20));}expect(await(await f.query('guard.state')).json()).toEqual({held:true});await writeFile(join(env.workspace.directory,'release-initialize'),'continue');expect(JSON.parse(await marker('agent-evidence.json')).method).toBe('session/new');expect(()=>process.kill(-pid,0)).not.toThrow();}
  finally{await f.command('guard.release',{});}
  const result=(await changing)[0]!;expect(result.status).toBe('fulfilled');if(result.status==='fulfilled')expect(result.value.status).toBe(409);await ready(f,'ready');expect((await f.command('sessions.endRun',{runId:started.result.runId})).status).toBe(200);await ready(f,'stopped');
});
