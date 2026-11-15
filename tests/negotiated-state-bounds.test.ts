import { afterEach, expect, test } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionEnvironment, sessionHost } from './fixtures/session-host.js';

type Cause='options-notify'|'options-response'|'mode-notify'|'mode-response';
const cleanup:Array<()=>Promise<void>>=[];
const proofs:unknown[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const prompt={image:true,audio:false,embeddedContext:true};
const modes={currentModeId:'m0-'+'a'.repeat(190),availableModes:Array.from({length:38},(_,index)=>({id:`m${index}-`+'a'.repeat(190),name:'M'.repeat(198)}))};
const options=[{id:'engine',name:'Research model',category:'model',type:'select',currentValue:'v0-'+'b'.repeat(190),options:Array.from({length:38},(_,index)=>({value:`v${index}-`+'b'.repeat(190),name:'V'.repeat(194)}))}];
async function waitFor<T>(read:()=>Promise<T>,accept:(value:T)=>boolean){const until=Date.now()+10000;let value:T;do{value=await read();if(accept(value))return value;await new Promise(resolve=>setTimeout(resolve,20));}while(Date.now()<until);throw Error('Expected state not reached: '+JSON.stringify(value!));}
function boundsAgent(cause:Cause){
 const initialModes=cause.startsWith('mode-')?{currentModeId:'s',availableModes:[{id:'s',name:'Short'},{id:'L'.repeat(200),name:'Long'}]}:structuredClone(modes);
 const initialOptions=cause==='options-notify'?[]:cause==='options-response'?[{id:'toggle',name:'Feature',type:'boolean',currentValue:false}]:structuredClone(options);
 if(cause==='options-response')for(const mode of initialModes.availableModes)mode.name=mode.name.slice(0,194);
 if(cause.startsWith('mode-')){
   // Fit an explicitly valid complete initial state just below the public
   // 16,000-byte bound, then select an already offered, longer current ID.
   let extra=Buffer.byteLength(JSON.stringify({revision:1,prompt,modes:initialModes,configOptions:initialOptions}))-15990;
   for(const option of initialOptions)if('options'in option)for(const choice of option.options){const take=Math.min(extra,choice.name.length-1);choice.name=choice.name.slice(0,choice.name.length-take);extra-=take;}
 }
 return `import{createInterface}from'node:readline';import{appendFileSync,existsSync,unlinkSync}from'node:fs';
if(process.argv[2]==='--version'){console.log('1.2.3');process.exit(0);}const healthy=existsSync('healthy-agent');const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
setInterval(()=>{if(healthy||!existsSync('emit-invalid-state'))return;unlinkSync('emit-invalid-state');send({method:'session/update',params:{sessionId:'native-bounds',update:${JSON.stringify(cause==='options-notify'?{sessionUpdate:'config_option_update',configOptions:options}:{sessionUpdate:'current_mode_update',currentModeId:'L'.repeat(200)})}}});appendFileSync('bounds-emitted','yes');},2);
createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);appendFileSync('bounds-wire',JSON.stringify(r)+'\\n');
if(r.method==='initialize')send({id:r.id,result:{protocolVersion:1,agentCapabilities:{promptCapabilities:${JSON.stringify(prompt)}},authMethods:[]}});
if(r.method==='session/new')send({id:r.id,result:{sessionId:'native-bounds',...(healthy?{configOptions:[]}:{modes:${JSON.stringify(initialModes)},configOptions:${JSON.stringify(initialOptions)}})}});
if(r.method==='session/set_config_option')send({id:r.id,result:{configOptions:${JSON.stringify(options)}}});
if(r.method==='session/set_mode')send({id:r.id,result:{}});
if(r.method==='session/prompt'){send({method:'session/update',params:{sessionId:'native-bounds',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Healthy reply'}}}});send({id:r.id,result:{stopReason:'end_turn'}});}});`;
}
async function setup(cause:Cause){const f=await sessionHost();cleanup.push(()=>f.close());await writeFile(join(f.directory,'controlled-agent.mjs'),boundsAgent(cause));
 async function start(healthy=false){const env=await sessionEnvironment(f);if(healthy)await writeFile(join(env.workspace.directory,'healthy-agent'),'yes');const session=(await(await f.command('sessions.create',env.input)).json()).result;expect((await f.command('sessions.startRun',{sessionId:session.id})).status).toBe(200);const run=(await waitFor(async()=>await(await f.query()).json(),value=>value.sessions.find((entry:{session:{id:string}})=>entry.session.id===session.id)?.execution.state==='ready')).sessions.find((entry:{session:{id:string}})=>entry.session.id===session.id).execution;return{env,session,run};}
 const affected=await start();const healthy=await start(true);return{f,affected,healthy};
}
async function assertHealthyStop(f:Awaited<ReturnType<typeof sessionHost>>,affected:Awaited<ReturnType<typeof setup>>['affected']){
 let attempts=0;return waitFor(async()=>{const query=await f.query();expect(query.status).toBe(200);const current=(await query.json()).sessions.find((entry:{session:{id:string}})=>entry.session.id===affected.session.id).execution;expect(Buffer.byteLength(JSON.stringify(current.negotiated))).toBeLessThanOrEqual(16000);const response=await f.command('workspace.createProject',{name:`Unaffected command ${attempts++}`,workspace:{name:'Still usable',management:'managed'}});expect(response.status).toBe(200);return current;},value=>value.state==='stopped');
}
async function saveProof(cause:Cause,before:Awaited<ReturnType<typeof setup>>['affected']['run'],after:Awaited<ReturnType<typeof setup>>['affected']['run']){proofs.push({cause,initialNegotiatedBytes:Buffer.byteLength(JSON.stringify(before.negotiated)),retainedNegotiatedBytes:Buffer.byteLength(JSON.stringify(after.negotiated)),state:after.state,configurationState:after.configuration?.state,revision:after.negotiated.revision,unrelatedWorkspaceCommandStatus:200,existingSiblingPromptCompleted:true});await writeFile('/tmp/aork17-complete-negotiated-bounds-proof.json',JSON.stringify(proofs,null,2));}
async function assertSiblingContinues(f:Awaited<ReturnType<typeof sessionHost>>,healthy:Awaited<ReturnType<typeof setup>>['healthy']){
 expect((await(await f.query()).json()).sessions.find((entry:{session:{id:string}})=>entry.session.id===healthy.session.id).execution.state).toBe('ready');const response=await f.command('sessions.sendText',{sessionId:healthy.session.id,text:'Still usable after invalid native state'});expect(response.status).toBe(200);const accepted=(await response.json()).result;await waitFor(async()=>await(await fetch(`${f.host.url}/api/resources/sessions.turn?turnId=${accepted.id}`,{headers:{Cookie:f.cookie}})).json(),value=>value.turn.state==='completed');
}

test('a large native option notification is bounded together with retained modes before publication',async()=>{
 const{f,affected,healthy}=await setup('options-notify');expect(Buffer.byteLength(JSON.stringify(affected.run.negotiated))).toBe(15981);await assertSiblingContinues(f,healthy);await writeFile(join(affected.env.workspace.directory,'emit-invalid-state'),'yes');await waitFor(async()=>{try{return await readFile(join(affected.env.workspace.directory,'bounds-emitted'),'utf8');}catch{return'';}},value=>value==='yes');const stopped=await assertHealthyStop(f,affected);expect(stopped.negotiated).toEqual(affected.run.negotiated);expect(stopped.reason).toContain('invalid configuration');await assertSiblingContinues(f,healthy);await saveProof('options-notify',affected.run,stopped);
});

test('a successful configuration RPC with oversized composed state stops only its Run without replay or storage poisoning',async()=>{
 const{f,affected,healthy}=await setup('options-response');await assertSiblingContinues(f,healthy);const payload={runId:affected.run.runId,generation:affected.run.generation,expectedRevision:1,change:{kind:'option',configId:'toggle',value:true}};const commandId=crypto.randomUUID();const response=await f.command('sessions.configureRun',payload,commandId);expect(response.status).toBe(200);const receipt=await response.json();
 const stopped=await assertHealthyStop(f,affected);expect(stopped.negotiated).toEqual(affected.run.negotiated);expect(stopped.configuration.state).toBe('delivery_unknown');await assertSiblingContinues(f,healthy);expect(await(await f.command('sessions.configureRun',payload,commandId)).json()).toEqual(receipt);
 const wire=()=>readFile(join(affected.env.workspace.directory,'bounds-wire'),'utf8').then(value=>value.trim().split('\n').map(line=>JSON.parse(line)));expect((await wire()).filter(value=>value.method==='session/set_config_option').map(value=>value.params)).toEqual([{sessionId:'native-bounds',configId:'toggle',type:'boolean',value:true}]);await f.restart();expect(await(await f.command('sessions.configureRun',payload,commandId)).json()).toEqual(receipt);expect((await wire()).filter(value=>value.method==='session/set_config_option')).toHaveLength(1);await saveProof('options-response',affected.run,stopped);expect((await f.command('workspace.createProject',{name:'Healthy after restart',workspace:{name:'Still healthy',management:'managed'}})).status).toBe(200);
});

for(const cause of ['mode-notify','mode-response'] as const)test(`${cause} validates the complete state when an offered current mode ID grows`,async()=>{
 const{f,affected,healthy}=await setup(cause);expect(Buffer.byteLength(JSON.stringify(affected.run.negotiated))).toBe(15990);await assertSiblingContinues(f,healthy);
 if(cause==='mode-notify'){await writeFile(join(affected.env.workspace.directory,'emit-invalid-state'),'yes');await waitFor(async()=>{try{return await readFile(join(affected.env.workspace.directory,'bounds-emitted'),'utf8');}catch{return'';}},value=>value==='yes');}
 else expect((await f.command('sessions.configureRun',{runId:affected.run.runId,generation:affected.run.generation,expectedRevision:1,change:{kind:'mode',modeId:'L'.repeat(200)}})).status).toBe(200);
 const stopped=await assertHealthyStop(f,affected);expect(stopped.negotiated).toEqual(affected.run.negotiated);if(cause==='mode-response')expect(stopped.configuration.state).toBe('delivery_unknown');await assertSiblingContinues(f,healthy);await saveProof(cause,affected.run,stopped);
});
