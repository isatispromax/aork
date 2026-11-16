import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {sessionHost,sessionEnvironment} from './session-host.js';
export async function waitEntry(f:Awaited<ReturnType<typeof sessionHost>>,state:string){let value:any;for(let n=0;n<400;n++){value=await(await f.query()).json();if(value.sessions?.[0]?.execution.state===state)return value.sessions[0];await new Promise(resolve=>setTimeout(resolve,20));}throw new Error(JSON.stringify(value));}
export async function resource(f:Awaited<ReturnType<typeof sessionHost>>,name:string,parameters:string){return fetch(`${f.host.url}/api/resources/${name}?${parameters}`,{headers:{Cookie:f.cookie}});}
export async function nativeRecoveryFixture(replacement:false|'recovery'=false){
 const f=await sessionHost(replacement,async({directory,distributionDir})=>{
  const path=join(distributionDir,'plugins/session-test-agent/0.1.0/server.js');
  const source=await readFile(path,'utf8');await writeFile(path,`import {existsSync} from 'node:fs';\n`+source.replace("parseParameters(value)",`inspectNativeSession({nativeSessionId}) {return {available:nativeSessionId==='native-persisted'&&existsSync(${JSON.stringify(join(directory,'native-history.json'))})};}, parseParameters(value)`));
 });
 const nativePath=join(f.directory,'native-history.json');const wirePath=join(f.directory,'native-wire');
 await writeFile(join(f.directory,'controlled-agent.mjs'),`import {readFileSync,writeFileSync,appendFileSync,existsSync} from 'node:fs';import{createInterface}from'node:readline';
 if(process.argv[2]==='--version'){console.log('1.2.3');process.exit(0);}
 const nativePath=${JSON.stringify(nativePath)},wirePath=${JSON.stringify(wirePath)};const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
 for await(const line of createInterface({input:process.stdin})){const request=JSON.parse(line);appendFileSync(wirePath,JSON.stringify({pid:process.pid,...request})+'\\n');if(!request.method)continue;let result={};
 if(request.method==='initialize')result={protocolVersion:1,agentCapabilities:{loadSession:true},agentInfo:{name:'persistent-peer',version:'1.2.3'}};
 else if(request.method==='session/new'){writeFileSync(nativePath,JSON.stringify([]));result={sessionId:'native-persisted'};}
 else if(request.method==='session/prompt'){const entries=JSON.parse(readFileSync(nativePath,'utf8'));const text=request.params.prompt[0].text;entries.push({role:'user',text,messageId:'user-'+entries.length},{role:'agent',text:'Saved answer',messageId:'agent-'+entries.length});writeFileSync(nativePath,JSON.stringify(entries));send({method:'session/update',params:{sessionId:'native-persisted',update:{sessionUpdate:'agent_message_chunk',messageId:entries.at(-1).messageId,content:{type:'text',text:'Saved answer'}}}});result={stopReason:'end_turn'};}
 else if(request.method==='session/load'){for(const entry of JSON.parse(readFileSync(nativePath,'utf8')))send({method:'session/update',params:{sessionId:request.params.sessionId,update:{sessionUpdate:entry.role+'_message_chunk',messageId:entry.messageId,content:{type:'text',text:entry.text}}}});}
 else continue;
 send({id:request.id,result});}
 `);
 const env=await sessionEnvironment(f);const session=(await(await f.command('sessions.create',env.input)).json()).result;
 assert.equal((await f.command('sessions.startRun',{sessionId:session.id})).status,200);const initial=await waitEntry(f,'ready');
 assert.equal((await f.command('sessions.sendText',{sessionId:session.id,text:'Retain original input'})).status,200);
 for(let n=0;n<200;n++){const timeline=await(await resource(f,'sessions.timeline',`sessionId=${session.id}`)).json();if(timeline.turns[0]?.state==='completed')break;await new Promise(resolve=>setTimeout(resolve,20));}
 assert.equal((await f.command('sessions.endRun',{runId:initial.execution.runId})).status,200);await waitEntry(f,'stopped');
 return{f,env,session,initial,nativePath,wirePath};
}
