import { afterEach, expect, test } from 'vitest';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionEnvironment, sessionHost } from './fixtures/session-host.js';
import { negotiatedAgent } from './fixtures/negotiated-agent.js';

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function eventually<T>(read:()=>Promise<T>,accept:(value:T)=>boolean){const until=Date.now()+10000;let value:T;do{value=await read();if(accept(value))return value;await new Promise(resolve=>setTimeout(resolve,2));}while(Date.now()<until);throw Error('Expected state: '+JSON.stringify(value!));}
async function records(directory:string,name:string){try{return(await readFile(join(directory,name),'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return[];throw error;}}
/** Files control only this external ACP peer. Native requests and effective modes are recorded independently. */
function revisionAgent(){return negotiatedAgent()
 .replace("import{appendFileSync}from'node:fs'","import{appendFileSync,existsSync,readFileSync,unlinkSync}from'node:fs'")
 .replace("let mode='inspect';","let mode=existsSync('new-run-mode')?readFileSync('new-run-mode','utf8'):'inspect';let held;")
 .replace("const send=x=>",`setImmediate(function pollRevision(){setImmediate(pollRevision);if(!existsSync('revision-switch'))return;const control=JSON.parse(readFileSync('revision-switch','utf8'));unlinkSync('revision-switch');mode=control.mode;send({method:'session/update',params:{sessionId:'native-negotiated',update:{sessionUpdate:'current_mode_update',currentModeId:mode}}});if(control.finish&&held){send({id:held,result:{stopReason:'end_turn'}});held=undefined;}});
const send=x=>`)
 .replace("if(r.method==='session/prompt'){",`if(r.method==='session/cancel'&&held){send({id:held,result:{stopReason:'cancelled'}});held=undefined;}
if(r.method==='session/prompt'){appendFileSync('native-effective',JSON.stringify({method:r.method,text:r.params.prompt[0].text,mode})+'\\n');if(r.params.prompt[0].text==='hold'){held=r.id;send({method:'session/update',params:{sessionId:'native-negotiated',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Holding first input'}}}});return;}`)
 .replace("if(r.method==='session/set_config_option'){","if(r.method==='session/set_config_option'){appendFileSync('native-effective',JSON.stringify({method:r.method,configId:r.params.configId,mode})+'\\n');");}
async function open(source=revisionAgent()){const f=await sessionHost();cleanup.push(()=>f.close());await writeFile(join(f.directory,'controlled-agent.mjs'),source);const env=await sessionEnvironment(f);const session=(await(await f.command('sessions.create',env.input)).json()).result;await f.command('sessions.startRun',{sessionId:session.id});await eventually(async()=>await(await f.query()).json(),value=>value.sessions[0]?.execution.state==='ready');return{f,env,session};}
async function timeline(f:Awaited<ReturnType<typeof sessionHost>>,sessionId:string){return(await fetch(`${f.host.url}/api/resources/sessions.timeline?sessionId=${sessionId}`,{headers:{Cookie:f.cookie}})).json();}

test('a native mode update after Runtime intent acceptance prevents an actual prompt under a different captured configuration',async()=>{
 const{f,env,session}=await open();let guarded=false;
 // Exercise the real restored-history lifecycle too. This keeps the proof
 // independent of the accidental timer alignment of an empty fresh Host.
 const history=await Promise.all(Array.from({length:80},(_,index)=>f.command('sessions.sendText',{sessionId:session.id,text:`warm-history-${index} ${'x'.repeat(8000)}`})));expect(history.every(response=>response.status===200)).toBe(true);
 await eventually(async()=>await(await f.query()).json(),value=>value.sessions[0].currentTurn?.acceptanceOrder===80&&value.sessions[0].currentTurn.state==='completed');await f.restart();expect((await f.command('sessions.startRun',{sessionId:session.id})).status).toBe(200);await eventually(async()=>await(await f.query()).json(),value=>value.sessions[0].execution.state==='ready');
 for(let trial=0;trial<128&&!guarded;trial++){
   const text=`effect-boundary-${trial}`;const receipt=await(await f.command('sessions.sendText',{sessionId:session.id,text})).json();
   let dispatching=false;for(let poll=0;poll<35;poll++){const observed=await(await f.query()).json();const turn=observed.sessions[0].currentTurn;if(turn?.id===receipt.result.id&&turn.state==='dispatching'){dispatching=true;break;}if(turn?.id===receipt.result.id&&['completed','failed'].includes(turn.state))break;}if(!dispatching)continue;
   const mode=receipt.result.configuration.modes.currentModeId==='inspect'?'write':'inspect';await writeFile(join(env.workspace.directory,'revision-switch-next'),JSON.stringify({mode}));await rename(join(env.workspace.directory,'revision-switch-next'),join(env.workspace.directory,'revision-switch'));
   const result=await eventually(()=>timeline(f,session.id),value=>value.turns.some((turn:{id:string;state:string})=>turn.id===receipt.result.id&&['completed','failed'].includes(turn.state)));
   await eventually(async()=>await(await f.query()).json(),value=>value.sessions[0].execution.negotiated.modes.currentModeId===mode);
   const native=(await records(env.workspace.directory,'native-effective')).find(value=>value.text===text);const turn=result.turns.find((turn:{id:string})=>turn.id===receipt.result.id);
   if(native){
     const events=(await(await fetch(`${f.host.url}/api/events?after=${receipt.events.at(-1)?.seq??'0'}&limit=100`,{headers:{Cookie:f.cookie}})).json()).events;
     const changed=events.find((event:{type:string;payload:any})=>event.type==='sessions.runChanged'&&event.payload.negotiated?.modes?.currentModeId===mode);
     const laterAttempt=changed&&events.some((event:{type:string;entityId:string;seq:string;payload:{state:string}})=>event.type==='sessions.turnChanged'&&event.entityId===receipt.result.id&&event.payload.state==='dispatching'&&BigInt(event.seq)>BigInt(changed.seq));
     // An Agent can change its own mode before Host receives its notification.
     // This regression concerns a change already durably observed by Host.
     if(laterAttempt)expect(native.mode).toBe(receipt.result.configuration.modes.currentModeId);
     continue;
   }
   expect(turn).toMatchObject({state:'failed',configuration:receipt.result.configuration});expect(turn.reason).toContain('configuration');await writeFile('/tmp/aork17-effect-boundary-proof.json',JSON.stringify({receipt:receipt.result,turn,nativeSent:false},null,2));guarded=true;
 }
 expect(guarded,'Controlled native update reached the pending-to-attempting window').toBe(true);
},30000);
test('queued input retains its original configuration when the Agent changes it before promotion',async()=>{
 const{f,env,session}=await open();await f.command('sessions.sendText',{sessionId:session.id,text:'hold'});await eventually(()=>timeline(f,session.id),value=>value.turns[0]?.state==='running');const queued=(await(await f.command('sessions.sendText',{sessionId:session.id,text:'original queued context'})).json()).result;
 await writeFile(join(env.workspace.directory,'revision-switch-next'),JSON.stringify({mode:'write',finish:true}));await rename(join(env.workspace.directory,'revision-switch-next'),join(env.workspace.directory,'revision-switch'));const result=await eventually(()=>timeline(f,session.id),value=>value.turns[1]?.state==='failed');expect(result.turns[1]).toMatchObject({configuration:queued.configuration,state:'failed'});expect(result.dispatchPaused).toBe(true);expect((await records(env.workspace.directory,'native-effective')).filter(value=>value.method==='session/prompt').map(value=>value.text)).toEqual(['hold']);
});
test('a configuration intent retains its accepted revision and fails visibly if a native update wins before initiation',async()=>{
 const{f,env,session}=await open();let guarded=false;
 for(let trial=0;trial<12&&!guarded;trial++){
   const before=(await(await f.query()).json()).sessions[0].execution;const mode=before.negotiated.modes.currentModeId==='inspect'?'write':'inspect';
   const response=await f.command('sessions.configureRun',{runId:before.runId,generation:before.generation,expectedRevision:before.negotiated.revision,change:{kind:'option',configId:'engine',value:trial%2?'research-small':'research-large'}});expect(response.status).toBe(200);const receipt=await response.json();
   await writeFile(join(env.workspace.directory,'revision-switch-next'),JSON.stringify({mode}));await rename(join(env.workspace.directory,'revision-switch-next'),join(env.workspace.directory,'revision-switch'));
   const after=(await eventually(async()=>await(await f.query()).json(),value=>value.sessions[0].execution.negotiated.modes.currentModeId===mode&&!['accepted','dispatching'].includes(value.sessions[0].execution.configuration?.state))).sessions[0].execution;
   const native=(await records(env.workspace.directory,'native-effective')).filter(value=>value.method==='session/set_config_option');const own=native.at(-1);
   expect(receipt.result.configuration.expectedRevision).toBe(before.negotiated.revision);
   if(after.configuration.state==='failed'){expect(after.configuration.reason).toContain('configuration');expect(native).toHaveLength(trial);guarded=true;}
   else{expect(own.mode).toBe(before.negotiated.modes.currentModeId);}
 }
 expect(guarded,'Controlled native update reached configuration acceptance-to-initiation window').toBe(true);
});

test('explicit queue continuation cannot confuse a successor Run revision one with a different effective configuration',async()=>{
 const{f,env,session}=await open();const original=(await(await f.query()).json()).sessions[0].execution;const first=(await(await f.command('sessions.sendText',{sessionId:session.id,text:'hold'})).json()).result;await eventually(()=>timeline(f,session.id),value=>value.turns[0]?.state==='running');const queued=(await(await f.command('sessions.sendText',{sessionId:session.id,text:'keep original inspect'})).json()).result;
 await f.command('sessions.cancelTurn',{turnId:first.id});await eventually(()=>timeline(f,session.id),value=>value.turns[0]?.state==='cancelled');await f.command('sessions.endRun',{runId:original.runId});await eventually(async()=>await(await f.query()).json(),value=>value.sessions[0].execution.state==='stopped');await writeFile(join(env.workspace.directory,'new-run-mode'),'write');await f.command('sessions.startRun',{sessionId:session.id});const next=(await eventually(async()=>await(await f.query()).json(),value=>value.sessions[0].execution.state==='ready')).sessions[0].execution;expect(next.negotiated).toMatchObject({revision:1,modes:{currentModeId:'write'}});expect(queued.configuration).toMatchObject({revision:1,modes:{currentModeId:'inspect'}});
 expect((await f.command('sessions.continueQueue',{sessionId:session.id,runId:next.runId,allowNewContext:true})).status).toBe(200);const result=await eventually(()=>timeline(f,session.id),value=>['failed','completed'].includes(value.turns[1]?.state));expect(result.turns[1]).toMatchObject({state:'failed',configuration:queued.configuration,configurationRun:{runId:original.runId,generation:original.generation}});expect((await records(env.workspace.directory,'native-effective')).filter(value=>value.method==='session/prompt').map(value=>value.text)).toEqual(['hold']);
});

test('permission response stays usable while configuration is busy and an Agent mode change safely fences the queued input',async()=>{
 const source=revisionAgent().replace("held=r.id;send({method:'session/update'", "held=r.id;send({id:'combined-permission',method:'session/request_permission',params:{sessionId:'native-negotiated',toolCall:{toolCallId:'read-context',title:'Read negotiated notes',status:'pending'},options:[{optionId:'allow-context',name:'Allow once',kind:'allow_once'}]}});send({method:'session/update'")
 .replace("if(r.method==='session/cancel'&&held)","if(r.id==='combined-permission'&&r.result?.outcome?.outcome==='selected'){mode='write';send({method:'session/update',params:{sessionId:'native-negotiated',update:{sessionUpdate:'current_mode_update',currentModeId:mode}}});send({id:held,result:{stopReason:'end_turn'}});held=undefined;}if(r.method==='session/cancel'&&held)");
 const{f,env,session}=await open(source);await f.command('sessions.sendText',{sessionId:session.id,text:'hold'});const interaction=(await eventually(async()=>await(await f.query('interactions.pending')).json(),value=>value.pending.length===1)).pending[0];const run=(await(await f.query()).json()).sessions[0].execution;
 const refused=await f.command('sessions.configureRun',{runId:run.runId,generation:run.generation,expectedRevision:run.negotiated.revision,change:{kind:'option',configId:'engine',value:'research-large'}});expect(refused.status).toBe(409);expect((await refused.json()).error.code).toBe('RUN_CONFIGURATION_BUSY');
 const queued=(await(await f.command('sessions.sendText',{sessionId:session.id,text:'after permission with captured inspect'})).json()).result;expect((await f.command('interactions.respond',{interactionId:interaction.id,optionId:'allow-context'})).status).toBe(200);const result=await eventually(()=>timeline(f,session.id),value=>value.turns[1]?.state==='failed');expect(result.turns[0].state).toBe('completed');expect(result.turns[1].configuration).toEqual(queued.configuration);expect(result.dispatchPaused).toBe(true);
 const native=await records(env.workspace.directory,'negotiated-wire');expect(native.filter(value=>value.id==='combined-permission'&&value.result).map(value=>value.result)).toEqual([{outcome:{outcome:'selected',optionId:'allow-context'}}]);expect(native.filter(value=>value.method==='session/prompt').map(value=>value.params.prompt[0].text)).toEqual(['hold']);expect(native.some(value=>value.method==='session/set_config_option')).toBe(false);expect((await(await f.query('interactions.pending')).json()).pending).toEqual([]);
});
