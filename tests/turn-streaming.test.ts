import { afterEach, expect, test } from 'vitest';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionEnvironment, sessionHost } from './fixtures/session-host.js';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const agent=`import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';
if(process.argv[2]==='--version'){console.log('1.2.3');process.exit(0);}
const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');
createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.method)appendFileSync('turn-wire',JSON.stringify(r)+'\\n');
if(r.method==='initialize')send({id:r.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});
if(r.method==='session/new')send({id:r.id,result:{sessionId:'native-turn'}});
if(r.method==='session/prompt'){send({method:'session/update',params:{sessionId:'native-turn',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Hello 🌏'}}}});send({method:'session/update',params:{sessionId:'native-turn',update:{sessionUpdate:'tool_call',toolCallId:'display-only',title:'Read notes',status:'in_progress',kind:'read'}}});send({method:'session/update',params:{sessionId:'native-turn',update:{sessionUpdate:'tool_call_update',toolCallId:'display-only',status:'completed'}}});send({method:'session/update',params:{sessionId:'native-turn',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:' — saved'}}}});send({id:r.id,result:{stopReason:'end_turn'}});}});`;
async function waitFor<T>(read:()=>Promise<T>,accept:(value:T)=>boolean){const deadline=Date.now()+10000;let value:T;do{value=await read();if(accept(value))return value;await new Promise(r=>setTimeout(r,20));}while(Date.now()<deadline);throw Error('Expected state not reached: '+JSON.stringify(value!));}
async function open(source=agent){const f=await sessionHost();cleanup.push(()=>f.close());await writeFile(join(f.directory,'controlled-agent.mjs'),source);const env=await sessionEnvironment(f);const session=(await(await f.command('sessions.create',env.input)).json()).result;const run=(await(await f.command('sessions.startRun',{sessionId:session.id})).json()).result;await waitFor(async()=>await(await f.query()).json(),v=>v.sessions[0]?.execution.state==='ready');return{f,env,session,run};}
async function timeline(f:Awaited<ReturnType<typeof sessionHost>>,sessionId:string){return await(await fetch(`${f.host.url}/api/resources/sessions.timeline?sessionId=${sessionId}`,{headers:{Cookie:f.cookie}})).json();}
test('text is accepted once with its whitespace, durable ordered chunks and display-only tools survive refresh and another Turn',async()=>{
 const {f,env,session}=await open();const commandId=crypto.randomUUID();const payload={sessionId:session.id,text:'  Research\n世界  '};
 const accepted=await f.command('sessions.sendText',payload,commandId);expect(accepted.status).toBe(200);const receipt=await accepted.json();expect(receipt.result.state).toBe('accepted');
 expect(await(await f.command('sessions.sendText',payload,commandId)).json()).toEqual(receipt);
 const value=await waitFor(()=>timeline(f,session.id),v=>v.turns?.[0]?.state==='completed');
 expect(value.messages.map((m:{text:string})=>m.text)).toEqual(['  Research\n世界  ','Hello 🌏',' — saved']);expect(value.tools).toEqual([expect.objectContaining({toolCallId:'display-only',title:'Read notes',status:'completed'})]);expect(value.turns[0].stopReason).toBe('end_turn');expect(value.turns[0].usage).toBeUndefined();
 expect((await f.command('sessions.sendText',{...payload,text:'changed'},commandId)).status).toBe(409);
 const wire=(await readFile(join(env.workspace.directory,'turn-wire'),'utf8')).split('\n').filter(Boolean).map(x=>JSON.parse(x));expect(wire.filter(r=>r.method==='session/prompt').map(r=>r.params.prompt)).toEqual([[{type:'text',text:payload.text}]]);
 expect(await timeline(f,session.id)).toEqual(value);expect((await f.command('sessions.sendText',{sessionId:session.id,text:'next'})).status).toBe(200);await waitFor(()=>timeline(f,session.id),v=>v.turns?.length===2&&v.turns[1].state==='completed');
});
