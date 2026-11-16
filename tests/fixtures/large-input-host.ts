import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionEnvironment, sessionHost } from './session-host.js';

/** Valid stable ACP options intentionally approach the public negotiated snapshot bound. */
export const largeOptions=[{id:'i'.repeat(200),name:'L'.repeat(200),category:'c'.repeat(200),type:'select',currentValue:'choice-0'+'v'.repeat(20),options:Array.from({length:100},(_,index)=>({value:`choice-${index}`+'v'.repeat(20),name:`${index}`.padEnd(100,'x')}))}];
export const largeAgent=`import{createInterface}from'node:readline';import{appendFileSync}from'node:fs';
if(process.argv[2]==='--version'){console.log('1.2.3');process.exit(0);}let held;const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);appendFileSync('large-input-wire',JSON.stringify(r)+'\\n');
if(r.method==='initialize')send({id:r.id,result:{protocolVersion:1,agentCapabilities:{promptCapabilities:{embeddedContext:true}},authMethods:[]}});
if(r.method==='session/new')send({id:r.id,result:{sessionId:'large-input-native',configOptions:${JSON.stringify(largeOptions)}}});
if(r.method==='session/prompt'){if(r.params.prompt[0].text==='hold'){held=r.id;send({method:'session/update',params:{sessionId:'large-input-native',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Holding large queue'}}}});}else send({id:r.id,result:{stopReason:'end_turn'}});}
if(r.method==='session/cancel'&&held){send({id:held,result:{stopReason:'cancelled'}});held=undefined;}});`;
export async function waitLarge<T>(read:()=>Promise<T>,accept:(value:T)=>boolean){const until=Date.now()+15000;let value:T;do{value=await read();if(accept(value))return value;await new Promise(resolve=>setTimeout(resolve,20));}while(Date.now()<until);throw Error('Expected state not reached: '+JSON.stringify(value!));}
export async function largeInputHost(prepare?:(f:Awaited<ReturnType<typeof sessionHost>>,env:Awaited<ReturnType<typeof sessionEnvironment>>)=>Promise<void>,replacement:false|'turns'=false){const f=await sessionHost(replacement);try{await writeFile(join(f.directory,'controlled-agent.mjs'),largeAgent);const env=await sessionEnvironment(f);await prepare?.(f,env);const session=(await(await f.command('sessions.create',env.input)).json()).result;await f.command('sessions.startRun',{sessionId:session.id});const run=(await waitLarge(async()=>await(await f.query()).json(),value=>value.sessions[0]?.execution.state==='ready')).sessions[0].execution;const first=(await(await f.command('sessions.sendText',{sessionId:session.id,text:'hold'})).json()).result;await waitLarge(async()=>await(await f.query()).json(),value=>value.sessions[0].currentTurn?.state==='running');return{f,env,session,run,first};}catch(error){await f.close();throw error;}}
