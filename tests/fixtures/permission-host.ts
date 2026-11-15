import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionEnvironment, sessionHost } from './session-host.js';
/** Independent public layout composes permission contracts before the default
 * Session UI is integrated. No private Session or Interactions module is imported. */
export async function permissionHost(replacement:boolean|'cards'=false){return sessionHost(false,async({directory,distributionDir,profile})=>{
  profile.plugins.push({id:'independent-permission-view',version:'0.1.0',enabled:true});
  profile.ui.providers['aork.sessions.detail@1']='independent-permission-view:detail';
  if(replacement===true)for(const name of ['cards','permission'])profile.ui.providers[`aork.interactions.${name}@1`]=`independent-permission-view:${name}`;
  if(replacement==='cards')profile.ui.providers['aork.interactions.cards@1']='independent-permission-view:pending-cards';
  const archive=join(directory,'independent-permission-view.aork-plugin');const profileFile=join(directory,'permission-profile.json');
  await writeFile(profileFile,JSON.stringify(profile));
  await promisify(execFile)(process.execPath,['scripts/plugin-build.mjs','--dir','tests/fixtures/permission-view','--out',archive]);
  await promisify(execFile)(process.execPath,['dist/server/main.mjs','plugin','install',archive,'--data-dir',join(directory,'data'),'--distribution-dir',distributionDir,'--profile',profileFile]);
});}
export const permissionAgent=`import{createInterface}from'node:readline';import{appendFileSync,existsSync}from'node:fs';import{dirname,join}from'node:path';import{fileURLToPath}from'node:url';
if(process.argv[2]==='--version'){console.log('1.2.3');process.exit(0);}let prompt;let selected=false;let continued=false;const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');
setInterval(()=>{if(selected&&!continued&&existsSync(join(dirname(fileURLToPath(import.meta.url)),'continue'))){continued=true;send({method:'session/update',params:{sessionId:'permission-native',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Agent continued after response'}}}});send({id:prompt.id,result:{stopReason:'end_turn'}});}},10);
createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);appendFileSync('permission-wire',JSON.stringify(r)+'\\n');
if(r.method==='initialize')send({id:r.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});
if(r.method==='session/new')send({id:r.id,result:{sessionId:'permission-native'}});
if(r.method==='session/prompt'){prompt=r;send({id:0,method:'session/request_permission',params:{sessionId:'permission-native',toolCall:{toolCallId:'write-1',title:'Write research notes',status:'pending'},options:[{optionId:'allow-once',name:'Allow once',kind:'allow_once'},{optionId:'deny-once',name:'Reject once',kind:'reject_once'}]}});}
if(r.id===0&&r.result?.outcome?.outcome==='selected')selected=true;
if(r.method==='session/cancel')send({id:prompt.id,result:{stopReason:'cancelled'}});
});`;
export async function startPermission(f:Awaited<ReturnType<typeof sessionHost>>){await writeFile(join(f.directory,'controlled-agent.mjs'),permissionAgent);const env=await sessionEnvironment(f);const created=await f.command('sessions.create',env.input);if(created.status!==200)throw Error(await created.text());const session=(await created.json()).result;const started=await f.command('sessions.startRun',{sessionId:session.id});if(started.status!==200)throw Error(await started.text());await waitPermission(async()=>await(await f.query()).json(),value=>value.sessions.find((entry:{session:{id:string}})=>entry.session.id===session.id)?.execution.state==='ready');await f.command('sessions.sendText',{sessionId:session.id,text:'Please ask permission'});const pending=await waitPermission(async()=>await(await f.query('interactions.pending')).json(),value=>value.pending.length===1);return{env,session,interaction:pending.pending[0]};}
export async function waitPermission<T>(read:()=>Promise<T>,accept:(value:T)=>boolean){const deadline=Date.now()+10000;let value:T;do{value=await read();if(accept(value))return value;await new Promise(resolve=>setTimeout(resolve,20));}while(Date.now()<deadline);throw Error('Expected permission state not reached: '+JSON.stringify(value!));}
export async function permissionWire(directory:string){return(await readFile(join(directory,'permission-wire'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));}
