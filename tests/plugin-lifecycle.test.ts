import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { afterEach, expect, test } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, cp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHost, maintainProfile } from '../apps/server/src/host.js';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(source = `export function activate(c) { c.query('sample.value', {access:'authenticated',execute:()=>({value:c.config.value??'initial',saved:c.state.get('saved')??null})});c.command('sample.save',{access:'authenticated',execute:v=>{c.state.set('saved',v);return v}}); }`, patch: Record<string, unknown> = {}, beforeStart?: (distributionDir:string, profile:{plugins:Array<Record<string,unknown>>})=>Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'aork-lifecycle-')); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const distributionDir = join(directory, 'dist'); await cp('dist', distributionDir, {recursive:true});
  const packageDir = join(distributionDir, 'plugins/sample/1.0.0');await mkdir(packageDir,{recursive:true});
  await writeFile(join(packageDir,'aork.plugin.json'),JSON.stringify({manifestVersion:1,id:'sample',version:'1.0.0',sdkRange:'~0.1.0',server:'server.js',configSchema:{type:'object',properties:{value:{type:'string',minLength:1}},additionalProperties:false},ui:{providers:[]},...patch}));
  await writeFile(join(packageDir,'server.js'),source);
  const profileFile=join(distributionDir,'profiles/personal-server.json');const profile=JSON.parse(await readFile(profileFile,'utf8'));profile.plugins.push({id:'sample',version:'1.0.0',enabled:true});await beforeStart?.(distributionDir,profile);await writeFile(profileFile,JSON.stringify(profile));
  const options={dataDir:join(directory,'data'),distributionDir,port:0,insecureLoopback:true};
  const host=await startHost(options);cleanup.push(()=>host.close());
  const login=await fetch(host.accessUrl!,{redirect:'manual'});const Cookie=login.headers.get('set-cookie')!.split(';')[0]!;
  async function boot(){return (await fetch(`${host.url}/api/bootstrap`,{headers:{Cookie}})).json();}
  async function command(name:string,payload:unknown, graph?:string){const b=await boot();return fetch(`${host.url}/api/commands/${name}`,{method:'POST',headers:{Cookie,Origin:host.url,'Content-Type':'application/json','X-Aork-CSRF':b.access.csrfToken},body:JSON.stringify({apiVersion:1,commandVersion:1,commandId:crypto.randomUUID(),pluginGraphHash:graph??b.pluginGraphHash,payload})});}
  const query=async(name:string)=>(await fetch(`${host.url}/api/queries/${name}`,{headers:{Cookie}}));
  return {directory,options,host,Cookie,boot,command,query};
}
/** An unaffected real Plugin owns the external-operation barrier, including during sample activation. */
async function installLifecycleBarrier(directory: string, profile: { plugins: Array<Record<string, unknown>> }, authority = false) {
  const packageDir = join(directory, 'plugins/lifecycle-control/1.0.0'); await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, 'aork.plugin.json'), JSON.stringify({ manifestVersion: 1, id: 'lifecycle-control', version: '1.0.0', sdkRange: '~0.1.0', server: 'server.js', provides: ['fixture.lifecycle-barrier@1'], ui: { providers: [] } }));
  await writeFile(join(packageDir, 'server.js'), `export function activate(c) {
    let waiting = false, released = false, held = false, releaseWait;
    c.provide('fixture.lifecycle-barrier@1', { async wait() {
      waiting = true;
      try { if (!released) await new Promise(resolve => { releaseWait = resolve; }); }
      finally { waiting = false; }
    } });
    c.query('barrier.status', { access: 'authenticated', execute: () => ({ waiting, released, held }) });
    c.command('barrier.release', { access: 'authenticated', execute() { released = true; releaseWait?.(); return { released }; } });
    ${authority ? "c.lifecycleGuard({ acquireChange() { if (held) return { state: 'busy', release() {} }; held = true; return { state: 'idle', release() { held = false; } }; } });" : ''}
  }`);
  profile.plugins.push({ id: 'lifecycle-control', version: '1.0.0', enabled: true });
}
test('protected plugin configuration validates unknown fields, changes the live service and survives restart',async()=>{
 const f=await fixture();expect((await fetch(`${f.host.url}/api/queries/plugins.management`)).status).toBe(401);
 const before=await f.boot();let response=await f.command('plugins.configure',{pluginId:'sample',config:{value:'updated'}});expect(response.status).toBe(200);
 expect(await(await f.query('sample.value')).json()).toMatchObject({value:'updated'});
 expect((await f.boot()).pluginGraphHash).not.toBe(before.pluginGraphHash);
 response=await f.command('plugins.configure',{pluginId:'sample',config:{unknown:'private-key-sentinel'}});expect(response.status).toBe(400);expect(await response.text()).not.toContain('private-key-sentinel');
 expect(await(await f.query('sample.value')).json()).toMatchObject({value:'updated'});
 await f.host.close();const maintained=await maintainProfile(f.options);expect(maintained.profile.plugins.find(p=>p.id==='sample')?.enabled).toBe(true);
 const restarted=await startHost(f.options);cleanup.push(()=>restarted.close());const login=await fetch(restarted.accessUrl!,{redirect:'manual'});const Cookie=login.headers.get('set-cookie')!.split(';')[0]!;
 expect(await(await fetch(`${restarted.url}/api/queries/sample.value`,{headers:{Cookie}})).json()).toMatchObject({value:'updated'});
});
test('repeated stop and restart releases scopes once, retains state, and failed activation restores the prior valid graph',async()=>{
 const f=await fixture(`export function activate(c){c.effect(()=>{c.state.set('active',(c.state.get('active')??0)+1);return async()=>{await new Promise(resolve=>setTimeout(resolve,10));c.state.set('active',c.state.get('active')-1)}});if(c.config.value==='fail')throw new Error('private-activation-secret');c.query('sample.value',{access:'authenticated',execute:()=>({value:c.config.value??'initial',active:c.state.get('active'),saved:c.state.get('saved')??null})});c.command('sample.save',{access:'authenticated',execute:v=>{c.state.set('saved',v);return v}});}`);
 expect((await f.command('sample.save','kept history')).status).toBe(200);
 for(let count=0;count<3;count++){expect((await f.command('plugins.setEnabled',{pluginId:'sample',enabled:false})).status).toBe(200);expect((await f.query('sample.value')).status).toBe(404);expect((await f.command('plugins.setEnabled',{pluginId:'sample',enabled:true})).status).toBe(200);expect(await(await f.query('sample.value')).json()).toMatchObject({active:1,saved:'kept history'});}
 const before=await f.boot();const failure=await f.command('plugins.configure',{pluginId:'sample',config:{value:'fail'}});expect(failure.status).toBe(503);expect(await failure.text()).not.toContain('private-activation-secret');
 expect((await f.boot()).pluginGraphHash).toBe(before.pluginGraphHash);expect(await(await f.query('sample.value')).json()).toMatchObject({value:'initial',active:1,saved:'kept history'});
});
test('an in-flight public operation blocks disposal and old page commands are rejected after a pure UI graph change',async()=>{
 const f=await fixture(`export function activate(c){const barrier=c.service('fixture.lifecycle-barrier@1');c.state.set('starts',(c.state.get('starts')??0)+1);c.command('sample.slow',{access:'authenticated',async execute(){c.state.set('working',true);try{await barrier.wait();return{completed:true}}finally{c.state.set('working',false)}}});c.query('sample.value',{access:'authenticated',execute:()=>({value:c.config.value??'initial',starts:c.state.get('starts'),working:c.state.get('working')??false})});}`,{requires:['fixture.lifecycle-barrier@1']},installLifecycleBarrier);
 // Attach rejection handlers immediately; assertion failure still releases and drains the request.
 const slow=Promise.allSettled([f.command('sample.slow',{})]);
 try {
  await expect.poll(async()=>(await(await f.query('barrier.status')).json()).waiting,{timeout:10_000,interval:20}).toBe(true);
  expect(await(await f.query('sample.value')).json()).toMatchObject({working:true});
  const refused=await f.command('plugins.setEnabled',{pluginId:'sample',enabled:false});expect(refused.status).toBe(409);expect((await refused.json()).error.code).toBe('PLUGIN_BUSY');
 } finally {
  try { await f.command('barrier.release',{}); } finally { await slow; }
 }
 const completed=(await slow)[0]!;if(completed.status==='rejected')throw completed.reason;expect(completed.value.status).toBe(200);
 const before=await f.boot();const ui=structuredClone(before.ui);ui.extensions=[{id:'plugin-diagnostics:section',order:20,hidden:true}];expect((await f.command('plugins.compose',{ui})).status).toBe(200);expect((await f.command('sample.slow',{},before.pluginGraphHash)).status).toBe(409);expect(await(await f.query('sample.value')).json()).toEqual({value:'initial',starts:1,working:false});
});
test('registered runtime authority fails closed for busy, unknown, thrown and missing status',async()=>{
 const f=await fixture(`export function activate(c){if(!c.state.get('registered')){c.lifecycleGuard({acquireChange:()=>{const mode=c.state.get('mode')??'busy';if(mode==='throw')throw new Error('private-status-secret');return {state:mode,release(){}}}});}c.query('sample.value',{access:'authenticated',execute:()=>c.config.value??'initial'});c.command('sample.mode',{access:'authenticated',execute:mode=>{c.state.set('mode',mode);return{ok:true}}});}`);
 for(const mode of ['busy','unknown','throw']){await f.command('sample.mode',mode);const response=await f.command('plugins.configure',{pluginId:'sample',config:{value:'later'}});expect(response.status).toBe(409);expect(['LIFECYCLE_BUSY','LIFECYCLE_UNKNOWN']).toContain((await response.json()).error.code);}
 await f.command('sample.mode','busy');const busyUi=(await f.boot()).ui;busyUi.extensions=[{id:'plugin-diagnostics:section',order:100,hidden:true}];expect((await f.command('plugins.compose',{ui:busyUi})).status).toBe(200);
 await f.command('sample.mode','idle');expect((await f.command('plugins.setEnabled',{pluginId:'sample',enabled:false})).status).toBe(200);
 const denied=await f.command('plugins.setEnabled',{pluginId:'sample',enabled:true});expect(denied.status).toBe(409);expect((await denied.json()).error.code).toBe('LIFECYCLE_UNKNOWN');
 await f.host.close();const restarted=await startHost(f.options);cleanup.push(()=>restarted.close());const login=await fetch(restarted.accessUrl!,{redirect:'manual'});const Cookie=login.headers.get('set-cookie')!.split(';')[0]!;const boot=await(await fetch(`${restarted.url}/api/bootstrap`,{headers:{Cookie}})).json();
 const afterRestart=await fetch(`${restarted.url}/api/commands/plugins.setEnabled`,{method:'POST',headers:{Cookie,Origin:restarted.url,'Content-Type':'application/json','X-Aork-CSRF':boot.access.csrfToken},body:JSON.stringify({apiVersion:1,commandVersion:1,commandId:crypto.randomUUID(),pluginGraphHash:boot.pluginGraphHash,payload:{pluginId:'sample',enabled:true}})});expect((await afterRestart.json()).error.code).toBe('LIFECYCLE_UNKNOWN');await restarted.close();
 const repair=await maintainProfile(f.options);repair.profile.plugins.find(plugin=>plugin.id==='sample')!.enabled=true;await maintainProfile({...f.options,profile:repair.profile});const restored=await startHost(f.options);cleanup.push(()=>restored.close());expect((await(await fetch(`${restored.url}/api/bootstrap`)).json()).diagnostics).toEqual([]);
});

test('configuration of a disabled plugin is validated before it can be saved and configuration fields require a declared schema',async()=>{
 const f=await fixture();await f.command('plugins.setEnabled',{pluginId:'sample',enabled:false});
 const invalid=await f.command('plugins.configure',{pluginId:'sample',config:{unknown:'hidden-value'}});expect(invalid.status).toBe(400);
 const inventory=await(await f.query('plugins.management')).json();expect(inventory.plugins.find((plugin:{id:string})=>plugin.id==='sample').config).toEqual({});
});

test('dependency revocation stops the complete consumer closure and each explicit re-enable restores one registration',async()=>{
 const f=await fixture(`export function activate(c){c.provide('sample.service@1',{value:'owned'});c.query('sample.value',{access:'authenticated',execute:()=>({ok:true})});}`,{provides:['sample.service@1']},async(directory,profile)=>{
  const packageDir=join(directory,'plugins/consumer/1.0.0');await mkdir(packageDir,{recursive:true});
  await writeFile(join(packageDir,'aork.plugin.json'),JSON.stringify({manifestVersion:1,id:'consumer',version:'1.0.0',sdkRange:'~0.1.0',server:'server.js',requires:['sample.service@1'],ui:{providers:[]}}));
  await writeFile(join(packageDir,'server.js'),`export function activate(c){const service=c.service('sample.service@1');c.effect(()=>{c.state.set('active',(c.state.get('active')??0)+1);return()=>c.state.set('active',c.state.get('active')-1)});c.query('consumer.value',{access:'authenticated',execute:()=>({value:service.value,active:c.state.get('active')})});}`);profile.plugins.push({id:'consumer',version:'1.0.0',enabled:true});
 });
 expect(await(await f.query('consumer.value')).json()).toEqual({value:'owned',active:1});
 for(let count=0;count<2;count++){expect((await f.command('plugins.setEnabled',{pluginId:'sample',enabled:false})).status).toBe(200);expect((await f.query('consumer.value')).status).toBe(404);const report=await(await f.query('plugins.management')).json();expect(report.plugins.find((plugin:{id:string})=>plugin.id==='consumer').enabled).toBe(false);await f.command('plugins.setEnabled',{pluginId:'sample',enabled:true});await f.command('plugins.setEnabled',{pluginId:'consumer',enabled:true});expect(await(await f.query('consumer.value')).json()).toEqual({value:'owned',active:1});}
});

test('an independent archive retains data through protected lifecycle commands and cannot claim the Host management service',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'aork-lifecycle-archive-'));cleanup.push(()=>rm(directory,{recursive:true,force:true}));const dataDir=join(directory,'data');const archive=join(directory,'plugin.aork-plugin');const file=join(directory,'profile.json');
 const profile=JSON.parse(await readFile('profiles/personal-server.json','utf8'));profile.plugins.push({id:'independent-lifecycle',version:'1.0.0',enabled:true});await writeFile(file,JSON.stringify(profile));
 async function pack(provides:string[]){const manifest={manifestVersion:1,id:'independent-lifecycle',version:'1.0.0',sdkRange:'~0.1.0',server:'server.js',provides,ui:{providers:[]}};const source=`export function activate(c){c.command('archive.save',{access:'authenticated',execute:value=>{c.state.set('saved',value);return{ok:true}}});c.query('archive.saved',{access:'authenticated',execute:()=>({saved:c.state.get('saved')??null})});}`;await writeFile(archive,JSON.stringify({archiveVersion:1,members:[['aork.plugin.json',JSON.stringify(manifest)],['server.js',source]].map(([path,source])=>{const bytes=Buffer.from(source!);return{path,type:'file',data:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex')}})}));}
 const execute=promisify(execFile);await pack(['aork.plugins.management@1']);const rejected=await execute(process.execPath,['dist/server/main.mjs','plugin','install',archive,'--profile',file,'--data-dir',dataDir]).catch(error=>error);expect(rejected.stderr).toContain('SERVICE_RESERVED');
 await pack([]);await execute(process.execPath,['dist/server/main.mjs','plugin','install',archive,'--profile',file,'--data-dir',dataDir]);const host=await startHost({dataDir,port:0,insecureLoopback:true});cleanup.push(()=>host.close());const login=await fetch(host.accessUrl!,{redirect:'manual'});const Cookie=login.headers.get('set-cookie')!.split(';')[0]!;
 async function command(name:string,payload:unknown){const boot=await(await fetch(`${host.url}/api/bootstrap`,{headers:{Cookie}})).json();return fetch(`${host.url}/api/commands/${name}`,{method:'POST',headers:{Cookie,Origin:host.url,'Content-Type':'application/json','X-Aork-CSRF':boot.access.csrfToken},body:JSON.stringify({apiVersion:1,commandVersion:1,commandId:crypto.randomUUID(),pluginGraphHash:boot.pluginGraphHash,payload})});}
 expect((await command('archive.save','independent history')).status).toBe(200);expect((await command('plugins.setEnabled',{pluginId:'independent-lifecycle',enabled:false})).status).toBe(200);expect((await command('plugins.setEnabled',{pluginId:'independent-lifecycle',enabled:true})).status).toBe(200);expect(await(await fetch(`${host.url}/api/queries/archive.saved`,{headers:{Cookie}})).json()).toEqual({saved:'independent history'});
 const invalid=await command('plugins.configure',{pluginId:'independent-lifecycle',config:{},unexpected:'private-command-value'});expect(invalid.status).toBe(400);expect(await invalid.text()).not.toContain('private-command-value');
});

test('the runtime admission barrier stays held until affected activation finishes and then releases',async()=>{
 const f=await fixture(`export async function activate(c){if(c.config.value)await c.service('fixture.lifecycle-barrier@1').wait();c.query('sample.value',{access:'authenticated',execute:()=>({value:c.config.value??'initial'})});}`,{requires:['fixture.lifecycle-barrier@1']},(directory,profile)=>installLifecycleBarrier(directory,profile,true));
 const changing=Promise.allSettled([f.command('plugins.configure',{pluginId:'sample',config:{value:'ready'}})]);
 try {
  await expect.poll(async()=>(await(await f.query('barrier.status')).json()),{timeout:10_000,interval:20}).toMatchObject({waiting:true,held:true});
  // The unaffected control remains callable while sample's new activation is awaiting its release.
  expect(await(await f.query('barrier.status')).json()).toEqual({waiting:true,released:false,held:true});
 } finally {
  try { await f.command('barrier.release',{}); } finally { await changing; }
 }
 const completed=(await changing)[0]!;if(completed.status==='rejected')throw completed.reason;expect(completed.value.status).toBe(200);
 expect(await(await f.query('barrier.status')).json()).toEqual({waiting:false,released:true,held:false});expect(await(await f.query('sample.value')).json()).toEqual({value:'ready'});
});
test('a plugin cannot mutate the Host configuration graph through nested readonly configuration',async()=>{
 const f=await fixture(`export function activate(c){let changed=false;try{c.config.nested.value='mutated';changed=true}catch{}c.query('sample.value',{access:'authenticated',execute:()=>({changed,value:c.config.nested.value})});}`,{configSchema:{type:'object',properties:{nested:{type:'object',properties:{value:{type:'string'}},required:['value'],additionalProperties:false}},required:['nested'],additionalProperties:false}},async(_directory,profile)=>{profile.plugins.find(item=>item.id==='sample')!.config={nested:{value:'original'}};});
 expect(await(await f.query('sample.value')).json()).toEqual({changed:false,value:'original'});const snapshot=await(await f.query('plugins.management')).json();expect(snapshot.plugins.find((plugin:{id:string})=>plugin.id==='sample').config).toEqual({nested:{value:'original'}});
});
test('an installed unselected exact package is listed and can be explicitly enabled without granting capabilities or replacing versions',async()=>{
 const f=await fixture(undefined,{},async(directory)=>{for(const version of ['1.0.0','2.0.0']){const packageDir=join(directory,'plugins/available',version);await mkdir(packageDir,{recursive:true});await writeFile(join(packageDir,'aork.plugin.json'),JSON.stringify({manifestVersion:1,id:'available',version,sdkRange:'~0.1.0',server:'server.js',ui:{providers:[]}}));await writeFile(join(packageDir,'server.js'),`export function activate(c){c.query('available.value',{access:'authenticated',execute:()=>({version:'${version}'})})}`);}});
 const inventory=await(await f.query('plugins.management')).json();expect(inventory.plugins).toContainEqual(expect.objectContaining({id:'available',version:'1.0.0',selected:false,status:'available'}));
 expect((await f.command('plugins.setEnabled',{pluginId:'available',version:'1.0.0',enabled:true})).status).toBe(200);expect(await(await f.query('available.value')).json()).toEqual({version:'1.0.0'});
 const forbidden=await f.command('plugins.setEnabled',{pluginId:'available',version:'2.0.0',enabled:true});expect(forbidden.status).toBe(409);expect((await forbidden.json()).error.code).toBe('PLUGIN_VERSION_CHANGE_REQUIRES_MAINTENANCE');
 const snapshot=await(await f.query('plugins.management')).json();await f.host.close();snapshot.profile.plugins=snapshot.profile.plugins.filter((plugin:{id:string})=>plugin.id!=='available');await maintainProfile({...f.options,profile:snapshot.profile});snapshot.profile.plugins.push({id:'available',version:'2.0.0',enabled:true});await expect(maintainProfile({...f.options,profile:snapshot.profile})).rejects.toMatchObject({code:'PLUGIN_VERSION_CHANGE_REQUIRES_MAINTENANCE'});
});
test('a new candidate needing schema DDL is refused live and in local profile repair without replacing the valid graph',async()=>{
 const f=await fixture(undefined,{},async(directory)=>{const packageDir=join(directory,'plugins/needs-schema/1.0.0');await mkdir(packageDir,{recursive:true});await writeFile(join(packageDir,'aork.plugin.json'),JSON.stringify({manifestVersion:1,id:'needs-schema',version:'1.0.0',sdkRange:'~0.1.0',server:'server.js',ui:{providers:[]}}));await writeFile(join(packageDir,'server.js'),`export const persistence={namespace:'plugin_needs_hschema__',migrations:[{version:1,statements:['CREATE TABLE plugin_needs_hschema__data (value TEXT)']}],statements:{}};export function activate(c){c.query('needs-schema.value',{access:'authenticated',execute:()=>({ok:true})});}`);});
 const before=await f.boot();const response=await f.command('plugins.setEnabled',{pluginId:'needs-schema',version:'1.0.0',enabled:true});expect(response.status).toBe(409);expect((await response.json()).error.code).toBe('PLUGIN_MAINTENANCE_REQUIRED');expect((await f.boot()).pluginGraphHash).toBe(before.pluginGraphHash);expect((await f.query('sample.value')).status).toBe(200);
 const snapshot=await(await f.query('plugins.management')).json();await f.host.close();snapshot.profile.plugins.push({id:'needs-schema',version:'1.0.0',enabled:true});await expect(maintainProfile({...f.options,profile:snapshot.profile})).rejects.toMatchObject({code:'PLUGIN_MAINTENANCE_REQUIRED'});expect((await maintainProfile(f.options)).profile.plugins.some(plugin=>plugin.id==='needs-schema')).toBe(false);
});
test('resource disposal waits for the actual asynchronous write even after the HTTP client disconnects',async()=>{
 const f=await fixture(`export function activate(c){let release;c.command('sample.release',{access:'authenticated',execute(){release();return{};}});c.query('sample.value',{access:'authenticated',execute:()=>({working:c.state.get('working')??false,saved:c.state.get('saved')??null})});c.resource('sample.io',{maxBytes:1024,async write(_parameters,bytes){c.state.set('working',true);await new Promise(resolve=>{release=resolve;});c.state.set('saved',new TextDecoder().decode(bytes));c.state.set('working',false);return{bytes:new TextEncoder().encode('{}'),mediaType:'application/json'}}});}`);
 const boot=await f.boot();const abort=new AbortController();const writing=fetch(`${f.host.url}/api/resources/sample.io`,{method:'POST',signal:abort.signal,headers:{Cookie:f.Cookie,Origin:f.host.url,'Content-Type':'application/octet-stream','X-Aork-CSRF':boot.access.csrfToken,'X-Aork-Graph':boot.pluginGraphHash},body:'physical write'}).catch(()=>undefined);
 let working=false;for(let attempt=0;attempt<30;attempt++){working=(await(await f.query('sample.value')).json()).working;if(working)break;await new Promise(resolve=>setTimeout(resolve,5));}expect(working).toBe(true);abort.abort();await writing;
 const refused=await f.command('plugins.setEnabled',{pluginId:'sample',enabled:false});expect(refused.status).toBe(409);expect((await refused.json()).error.code).toBe('PLUGIN_BUSY');
 await f.command('sample.release',{});
 for(let attempt=0;attempt<60;attempt++){if(!(await(await f.query('sample.value')).json()).working)break;await new Promise(resolve=>setTimeout(resolve,10));}
 expect((await f.command('plugins.setEnabled',{pluginId:'sample',enabled:false})).status).toBe(200);expect((await f.command('plugins.setEnabled',{pluginId:'sample',enabled:true})).status).toBe(200);expect(await(await f.query('sample.value')).json()).toEqual({working:false,saved:'physical write'});
});
test('Host shutdown drains an admitted resource operation after its client has disconnected',async()=>{
 const f=await fixture(`export function activate(c){c.query('sample.value',{access:'authenticated',execute:()=>({working:c.state.get('working')??false,saved:c.state.get('saved')??null})});c.resource('sample.io',{maxBytes:1024,async write(){c.state.set('working',true);await new Promise(resolve=>setTimeout(resolve,200));c.state.set('saved','finished before shutdown');c.state.set('working',false);return{bytes:new TextEncoder().encode('{}'),mediaType:'application/json'}}});}`);
 const boot=await f.boot();const abort=new AbortController();const writing=fetch(`${f.host.url}/api/resources/sample.io`,{method:'POST',signal:abort.signal,headers:{Cookie:f.Cookie,Origin:f.host.url,'Content-Type':'application/octet-stream','X-Aork-CSRF':boot.access.csrfToken,'X-Aork-Graph':boot.pluginGraphHash},body:'write'}).catch(()=>undefined);let working=false;for(let attempt=0;attempt<30;attempt++){working=(await(await f.query('sample.value')).json()).working;if(working)break;await new Promise(resolve=>setTimeout(resolve,5));}expect(working).toBe(true);abort.abort();await writing;await f.host.close();
 const restarted=await startHost(f.options);cleanup.push(()=>restarted.close());const login=await fetch(restarted.accessUrl!,{redirect:'manual'});const Cookie=login.headers.get('set-cookie')!.split(';')[0]!;expect(await(await fetch(`${restarted.url}/api/queries/sample.value`,{headers:{Cookie}})).json()).toEqual({working:false,saved:'finished before shutdown'});
});
test('first selection never automatically grants the capabilities requested by an installed candidate',async()=>{
 const f=await fixture(undefined,{},async(directory)=>{const packageDir=join(directory,'plugins/needs-grant/1.0.0');await mkdir(packageDir,{recursive:true});await writeFile(join(packageDir,'aork.plugin.json'),JSON.stringify({manifestVersion:1,id:'needs-grant',version:'1.0.0',sdkRange:'~0.1.0',server:'server.js',capabilities:['diagnostics.read'],ui:{providers:[]}}));await writeFile(join(packageDir,'server.js'),'export function activate(){}');});
 const response=await f.command('plugins.setEnabled',{pluginId:'needs-grant',version:'1.0.0',enabled:true});expect(response.status).toBe(400);expect((await response.json()).error.code).toBe('CAPABILITY_NOT_GRANTED');const snapshot=await(await f.query('plugins.management')).json();expect(snapshot.plugins).toContainEqual(expect.objectContaining({id:'needs-grant',selected:false,capabilities:['diagnostics.read']}));expect(snapshot.profile.plugins.some((plugin:{id:string})=>plugin.id==='needs-grant')).toBe(false);
});
test('failed cleanup leaves affected scopes closed and refuses a second destructive change with a safe diagnostic',async()=>{
 const f=await fixture(`export function activate(c){c.effect(()=>()=>{throw new Error('private-cleanup-resource')});c.query('sample.value',{access:'authenticated',execute:()=>({ok:true})});}`);
 const response=await f.command('plugins.setEnabled',{pluginId:'sample',enabled:false});expect(response.status).toBe(503);expect(await response.text()).not.toContain('private-cleanup-resource');const next=await f.command('plugins.configure',{pluginId:'sample',config:{value:'retry'}});expect(next.status).toBe(409);expect((await next.json()).error.code).toBe('LIFECYCLE_UNKNOWN');const snapshot=await(await f.query('plugins.diagnostics')).json();expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({code:'PLUGIN_CLEANUP_FAILED'}));
});
test('partial rollback failure closes the full affected dependency closure and reports a safe recovery diagnostic',async()=>{
 const f=await fixture(`export function activate(c){if(c.config.value==='fail')throw new Error('private-candidate-failure');c.provide('sample.service@1',{});c.query('sample.value',{access:'authenticated',execute:()=>({ok:true})});}`,{provides:['sample.service@1']},async(directory,profile)=>{const packageDir=join(directory,'plugins/rollback-consumer/1.0.0');await mkdir(packageDir,{recursive:true});await writeFile(join(packageDir,'aork.plugin.json'),JSON.stringify({manifestVersion:1,id:'rollback-consumer',version:'1.0.0',sdkRange:'~0.1.0',server:'server.js',requires:['sample.service@1'],ui:{providers:[]}}));await writeFile(join(packageDir,'server.js'),`let starts=0;export function activate(c){if(++starts>1)throw new Error('private-rollback-failure');c.query('rollback-consumer.value',{access:'authenticated',execute:()=>({ok:true})});}`);profile.plugins.push({id:'rollback-consumer',version:'1.0.0',enabled:true});});
 const before=await f.boot();const response=await f.command('plugins.configure',{pluginId:'sample',config:{value:'fail'}});expect(response.status).toBe(503);expect(await response.text()).not.toContain('private-rollback-failure');expect((await f.query('sample.value')).ok).toBe(false);expect((await f.boot()).pluginGraphHash).toBe(before.pluginGraphHash);const snapshot=await(await f.query('plugins.diagnostics')).json();expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({code:'PLUGIN_ROLLBACK_FAILED'}));expect((await f.command('plugins.configure',{pluginId:'sample',config:{value:'retry'}})).status).toBe(409);
});
