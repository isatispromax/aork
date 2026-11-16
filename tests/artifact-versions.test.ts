import { afterEach, expect, test } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionEnvironment, sessionHost } from './fixtures/session-host.js';
const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const agent=`import {createInterface} from 'node:readline';if(process.argv[2]==='--version'){console.log('1.2.3');process.exit(0);}const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.method==='initialize')send({id:r.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});if(r.method==='session/new')send({id:r.id,result:{sessionId:'artifact-native'}});if(r.method==='session/prompt')send({id:r.id,result:{stopReason:'end_turn'}});});`;
async function fixture(){const f=await sessionHost();cleanup.push(()=>f.close());await writeFile(join(f.directory,'controlled-agent.mjs'),agent);const env=await sessionEnvironment(f);const session=(await(await f.command('sessions.create',env.input)).json()).result;await f.command('sessions.startRun',{sessionId:session.id});await expect.poll(async()=>(await(await f.query()).json()).sessions[0].execution.state).toBe('ready');const turn=(await(await f.command('sessions.sendText',{sessionId:session.id,text:'Create result'})).json()).result;return{f,env,session,turn};}
function resource(f:Awaited<ReturnType<typeof sessionHost>>,name:string,parameters:Record<string,string>){return fetch(`${f.host.url}/api/resources/artifacts.${name}?${new URLSearchParams(parameters)}`,{headers:{Cookie:f.cookie}});}
function snapshot(f:Awaited<ReturnType<typeof sessionHost>>,name:string,parameters:Record<string,string>){return fetch(`${f.host.url}/api/snapshots/artifacts.${name}?${new URLSearchParams(parameters)}`,{headers:{Cookie:f.cookie}});}
test('explicit capture keeps immutable ordered versions, provenance and one durable receipt across retry and restart',async()=>{
 const {f,env,session,turn}=await fixture();await writeFile(join(env.workspace.directory,'result.txt'),'first immutable bytes\n');
 const payload={projectId:env.project.id,title:'Report',source:{kind:'captured-file',workspaceId:env.workspace.id,relativePath:'result.txt'},association:{sessionId:session.id,turnId:turn.id}};const commandId=crypto.randomUUID();
 const response=await f.command('artifacts.register',payload,commandId);expect(response.status).toBe(200);const receipt=await response.json();const first=receipt.result;
 expect(first).toMatchObject({artifactId:expect.any(String),versionId:expect.any(String),ordinal:1});
 expect(await(await resource(f,'file',{versionId:first.versionId})).text()).toBe('first immutable bytes\n');
 await writeFile(join(env.workspace.directory,'result.txt'),'second contents');
 expect(await(await f.command('artifacts.register',payload,commandId)).json()).toEqual(receipt);
 expect((await f.command('artifacts.register',{...payload,title:'Changed'},commandId)).status).toBe(409);
 const second=(await(await f.command('artifacts.register',{...payload,artifactId:first.artifactId})).json()).result;expect(second.ordinal).toBe(2);
 expect(await(await resource(f,'file',{versionId:first.versionId})).text()).toBe('first immutable bytes\n');expect(await(await resource(f,'file',{versionId:second.versionId})).text()).toBe('second contents');
 const detail=await(await snapshot(f,'detail',{artifactId:first.artifactId,versionId:first.versionId})).json();expect(detail.snapshot.selected).toMatchObject({id:first.versionId,ordinal:1,provenance:{kind:'registered-by-user',association:{sessionId:session.id,turnId:turn.id}},content:{kind:'captured-file',size:22,source:{workspaceId:env.workspace.id,relativePath:'result.txt'}}});
 await f.restart();expect(await(await resource(f,'file',{versionId:first.versionId})).text()).toBe('first immutable bytes\n');expect(await(await f.command('artifacts.register',payload,commandId)).json()).toEqual(receipt);
});
