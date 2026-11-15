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
 const f=await fixture(`export function activate(c){c.effect(()=>{c.state.set('active',(c.state.get('active')??0)+1);return()=>c.state.set('active',c.state.get('active')-1)});if(c.config.value==='fail')throw new Error('private-activation-secret');c.query('sample.value',{access:'authenticated',execute:()=>({value:c.config.value??'initial',active:c.state.get('active'),saved:c.state.get('saved')??null})});c.command('sample.save',{access:'authenticated',execute:v=>{c.state.set('saved',v);return v}});}`);
 expect((await f.command('sample.save','kept history')).status).toBe(200);
 for(let count=0;count<3;count++){expect((await f.command('plugins.setEnabled',{pluginId:'sample',enabled:false})).status).toBe(200);expect((await f.query('sample.value')).status).toBe(404);expect((await f.command('plugins.setEnabled',{pluginId:'sample',enabled:true})).status).toBe(200);expect(await(await f.query('sample.value')).json()).toMatchObject({active:1,saved:'kept history'});}
 const before=await f.boot();const failure=await f.command('plugins.configure',{pluginId:'sample',config:{value:'fail'}});expect(failure.status).toBe(503);expect(await failure.text()).not.toContain('private-activation-secret');
 expect((await f.boot()).pluginGraphHash).toBe(before.pluginGraphHash);expect(await(await f.query('sample.value')).json()).toMatchObject({value:'initial',active:1,saved:'kept history'});
});
test('an in-flight public operation blocks disposal and old page commands are rejected after a pure UI graph change',async()=>{
 const f=await fixture(`export function activate(c){c.state.set('starts',(c.state.get('starts')??0)+1);c.command('sample.slow',{access:'authenticated',async execute(){await new Promise(resolve=>setTimeout(resolve,150));return{completed:true}}});c.query('sample.value',{access:'authenticated',execute:()=>({value:c.config.value??'initial',starts:c.state.get('starts')})});}`);
 const slow=f.command('sample.slow',{});await new Promise(resolve=>setTimeout(resolve,30));const refused=await f.command('plugins.setEnabled',{pluginId:'sample',enabled:false});expect(refused.status).toBe(409);expect((await refused.json()).error.code).toBe('PLUGIN_BUSY');expect((await slow).status).toBe(200);
 const before=await f.boot();const ui=structuredClone(before.ui);ui.extensions=[{id:'plugin-diagnostics:section',order:20,hidden:true}];expect((await f.command('plugins.compose',{ui})).status).toBe(200);expect((await f.command('sample.slow',{},before.pluginGraphHash)).status).toBe(409);expect(await(await f.query('sample.value')).json()).toEqual({value:'initial',starts:1});
});
test('registered runtime authority fails closed for busy, unknown, thrown and missing status across restart',async()=>{
 const f=await fixture(`export function activate(c){if(!c.state.get('registered')){c.lifecycleGuard({inspect:()=>{const mode=c.state.get('mode')??'busy';if(mode==='throw')throw new Error('private-status-secret');return mode}});}c.query('sample.value',{access:'authenticated',execute:()=>c.config.value??'initial'});c.command('sample.mode',{access:'authenticated',execute:mode=>{c.state.set('mode',mode);return{ok:true}}});}`);
 for(const mode of ['busy','unknown','throw']){await f.command('sample.mode',mode);const response=await f.command('plugins.configure',{pluginId:'sample',config:{value:'later'}});expect(response.status).toBe(409);expect(['LIFECYCLE_BUSY','LIFECYCLE_UNKNOWN']).toContain((await response.json()).error.code);}
 await f.command('sample.mode','idle');expect((await f.command('plugins.setEnabled',{pluginId:'sample',enabled:false})).status).toBe(200);
 const denied=await f.command('plugins.setEnabled',{pluginId:'sample',enabled:true});expect(denied.status).toBe(409);expect((await denied.json()).error.code).toBe('LIFECYCLE_UNKNOWN');
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
