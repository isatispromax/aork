import { afterEach, expect, test } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionEnvironment, sessionHost } from './fixtures/session-host.js';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
async function eventually<T>(read:()=>Promise<T>,accept:(value:T)=>boolean){const end=Date.now()+8000;let value:T;do{value=await read();if(accept(value))return value;await new Promise(resolve=>setTimeout(resolve,5));}while(Date.now()<end);throw new Error('Public response boundary not reached: '+JSON.stringify(value!));}
type Kind='permission'|'form';
function peer(kind:Kind,blocked=false){
  const request=kind==='permission'?{id:'choice',method:'session/request_permission',params:{sessionId:'response-native',toolCall:{toolCallId:'write-one',title:'Saved permission',status:'pending'},options:[{optionId:'allow',name:'Allow',kind:'allow_once'}]}}:{id:'choice',method:'elicitation/create',params:{mode:'form',sessionId:'response-native',message:'Saved form',requestedSchema:{type:'object',properties:{topic:{type:'string'}},required:['topic']}}};
  return `import{createInterface}from'node:readline';import{appendFileSync,existsSync}from'node:fs';if(process.argv[2]==='--version'){console.log('1.2.3');process.exit(0);}let observed=false;setInterval(()=>{if(existsSync('peer-self-exit'))process.exit(0);if(!observed&&existsSync('observe-blocked-response')){observed=true;setTimeout(()=>send({method:'session/update',params:{sessionId:'response-native',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Blocked native response observation'}}}}),100);}},20);process.stdout.on('error',()=>{});const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);appendFileSync('response-wire',JSON.stringify(r)+'\\n');if(r.method==='initialize')send({id:r.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});if(r.method==='session/new')send({id:r.id,result:{sessionId:'response-native'}});if(r.method==='session/prompt'){${blocked?"process.stdin.pause();send({id:'fill',method:'unknown'+('X'.repeat(400000)),params:{}});":''}send(${JSON.stringify(request)});}});`;
}
async function open(kind:Kind,crashOnResponded=false,blocked=false){
  let marker='';const f=await sessionHost(false,async({directory,distributionDir,profile})=>{
    if(!crashOnResponded)return;marker=join(directory,'response-terminal-crash');const id='response-terminal-observer';const plugin=join(distributionDir,'plugins',id,'0.1.0');await mkdir(plugin,{recursive:true});
    await writeFile(join(plugin,'aork.plugin.json'),JSON.stringify({manifestVersion:1,id,version:'0.1.0',sdkRange:'^0.1.0',server:'server.js',requires:['aork.runtime.acp@1'],ui:{providers:[]}}));
    await writeFile(join(plugin,'server.js'),`import{existsSync,writeFileSync}from'node:fs';export function activate(c){const runtime=c.service('aork.runtime.acp@1');c.consumeFacts(runtime.${kind==='permission'?'permissionFacts':'inputFacts'},{id:'beforeResponseProjectionCrash',events:{},apply(fact){const value=fact.payload.interaction;if(value.state==='responded'&&!existsSync(${JSON.stringify(marker)})){writeFileSync(${JSON.stringify(marker)},value.id,{flag:'wx'});process.kill(process.pid,'SIGKILL');}return{principal:fact.payload.principal,events:[]};}});}`);
    profile.plugins.push({id,version:'0.1.0',enabled:true});const path=join(distributionDir,'plugins/interactions/0.1.0/aork.plugin.json');const manifest=JSON.parse(await readFile(path,'utf8'));manifest.dependencies=[...(manifest.dependencies??[]),{id,range:'^0.1.0'}];await writeFile(path,JSON.stringify(manifest));
  });cleanup.push(()=>f.close());await writeFile(join(f.directory,'controlled-agent.mjs'),peer(kind,blocked));const env=await sessionEnvironment(f);cleanup.push(async()=>{await writeFile(join(env.workspace.directory,'peer-self-exit'),'exit');});const session=(await(await f.command('sessions.create',env.input)).json()).result;await f.command('sessions.startRun',{sessionId:session.id});await eventually(async()=>(await(await f.query()).json()).sessions[0]?.execution.state,state=>state==='ready');await f.command('sessions.sendText',{sessionId:session.id,text:'Review saved response'});
  const pending=await eventually(async()=>await(await f.query(kind==='permission'?'interactions.pending':'interactions.inputPending')).json(),value=>value.pending?.length===1);const interaction=pending.pending[0];const command=kind==='permission'?'interactions.respond':'interactions.submit';const payload=kind==='permission'?{interactionId:interaction.id,optionId:'allow'}:{interactionId:interaction.id,action:'accept',content:{topic:'Saved answer'}};
  return{f,env,session,interaction,command,payload,marker};
}
async function terminalEvents(f:Awaited<ReturnType<typeof sessionHost>>,id:string){const events=await(await fetch(`${f.host.url}/api/events?after=0&limit=100`,{headers:{Cookie:f.cookie}})).json();return events.events.filter((event:any)=>event.payload.id===id&&!['pending','responding'].includes(event.payload.state)).map((event:any)=>event.payload.state);}
for(const kind of ['permission','form'] as const)test(`restart catches up an unprojected definitive ${kind} response before inventing any fallback uncertainty`,async()=>{
  const{f,interaction,command,payload,marker}=await open(kind,true);const commandId=crypto.randomUUID();const receipt=await(await f.command(command,payload,commandId)).json();expect(receipt.result.state).toBe('responding');
  expect(await eventually(async()=>{try{return await readFile(marker,'utf8');}catch{return'';}},value=>Boolean(value))).toBe(interaction.id);await f.crashAndRestart();
  const history=await(await f.query(kind==='permission'?'interactions.history':'interactions.inputHistory')).json();expect(history.interactions).toEqual([expect.objectContaining({id:interaction.id,state:'responded'})]);
  expect(await terminalEvents(f,interaction.id)).toEqual(['responded']);expect(await(await f.command(command,payload,commandId)).json()).toEqual(receipt);expect((await f.command(command,payload)).status).toBe(409);await f.restart();expect(await terminalEvents(f,interaction.id)).toEqual(['responded']);
});

for(const kind of ['permission','form'] as const){
  test(`restart expires an accepted but unattempted ${kind} response once without inventing delivery uncertainty`,async()=>{
    const{f,env,interaction,command,payload}=await open(kind);const response=await f.command(command,payload);expect(response.status).toBe(200);const receipt=await response.json();expect(receipt.result.state).toBe('responding');
    await f.crashAndRestart();const history=await(await f.query(kind==='permission'?'interactions.history':'interactions.inputHistory')).json();expect(history.interactions).toEqual([expect.objectContaining({id:interaction.id,state:'expired'})]);expect(await terminalEvents(f,interaction.id)).toEqual(['expired']);
    const wire=(await readFile(join(env.workspace.directory,'response-wire'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));expect(wire.filter(value=>value.id==='choice'&&value.result)).toEqual([]);
  });
  test(`restart preserves one unknown result for an attempted ${kind} response blocked behind the actual native writer`,async()=>{
    const{f,env,session,interaction,command,payload}=await open(kind,false,true);const id=crypto.randomUUID();const receipt=await(await f.command(command,payload,id)).json();expect(receipt.result.state).toBe('responding');
    await writeFile(join(env.workspace.directory,'observe-blocked-response'),'observe');
    await eventually(async()=>await(await fetch(`${f.host.url}/api/resources/sessions.timeline?sessionId=${session.id}`,{headers:{Cookie:f.cookie}})).json(),value=>value.messages.some((message:any)=>message.text==='Blocked native response observation'));
    await f.crashAndRestart();const history=await(await f.query(kind==='permission'?'interactions.history':'interactions.inputHistory')).json();expect(history.interactions).toEqual([expect.objectContaining({id:interaction.id,state:'delivery_unknown'})]);expect(await terminalEvents(f,interaction.id)).toEqual(['delivery_unknown']);expect(await(await f.command(command,payload,id)).json()).toEqual(receipt);
    const wire=(await readFile(join(env.workspace.directory,'response-wire'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));expect(wire.filter(value=>value.id==='choice'&&value.result)).toEqual([]);
  });
}
