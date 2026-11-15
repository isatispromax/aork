import {expect,test} from 'vitest';
import {sessionHost} from './fixtures/session-host.js';
import {mkdir,writeFile} from 'node:fs/promises';import {join} from 'node:path';
test('ordinary callbacks cannot borrow a concurrent teardown write scope after their Plugin is revoked',async()=>{
const f=await sessionHost(false,async({distributionDir,profile})=>{
  for(const id of ['cleanup-control','late-write-probe'])await mkdir(join(distributionDir,'plugins',id,'0.1.0'),{recursive:true});
  const control=join(distributionDir,'plugins/cleanup-control/0.1.0');
  await writeFile(join(control,'aork.plugin.json'),JSON.stringify({manifestVersion:1,id:'cleanup-control',version:'0.1.0',sdkRange:'^0.1.0',server:'server.js',provides:['fixture.cleanup@1'],ui:{providers:[]}}));
  await writeFile(join(control,'server.js'),`export function activate(c){let held=false,result=null,release,released=false;const service={inspect:()=>({held,result}),mark:value=>{result=value;},wait(){if(released)return Promise.resolve();held=true;return new Promise(resolve=>{release=resolve;});}};c.provide('fixture.cleanup@1',service);c.query('cleanup.status',{access:'authenticated',execute:()=>service.inspect()});c.command('cleanup.release',{access:'authenticated',execute(){held=false;released=true;release?.();return{};}});}`);
  const probe=join(distributionDir,'plugins/late-write-probe/0.1.0');
  await writeFile(join(probe,'aork.plugin.json'),JSON.stringify({manifestVersion:1,id:'late-write-probe',version:'0.1.0',sdkRange:'^0.1.0',server:'server.js',requires:['fixture.cleanup@1'],ui:{providers:[]}}));
  await writeFile(join(probe,'server.js'),`export const persistence={namespace:'plugin_late_hwrite_hprobe__',migrations:[{version:1,statements:['CREATE TABLE plugin_late_hwrite_hprobe__writes (id TEXT PRIMARY KEY)']}],statements:{insert:{sql:'INSERT INTO plugin_late_hwrite_hprobe__writes (id) VALUES (?)',mode:'write'},list:{sql:'SELECT id FROM plugin_late_hwrite_hprobe__writes',mode:'read'}}};export function activate(c){const control=c.service('fixture.cleanup@1');c.query('late.records',{access:'authenticated',execute:()=>c.repository.all('list')});c.command('late.arm',{access:'authenticated',execute(){void(async()=>{while(!control.inspect().held)await new Promise(resolve=>setTimeout(resolve,10));try{c.transactions.run(tx=>c.repository.run(tx,'insert',['late-write']));control.mark({written:true});}catch(error){control.mark({written:false,code:error.code});}})();return{};}});c.effect(()=>()=>control.wait());}`);
  profile.plugins.push({id:'cleanup-control',version:'0.1.0',enabled:true},{id:'late-write-probe',version:'0.1.0',enabled:true});
});
let pending:Promise<PromiseSettledResult<Response>[]>|undefined;
try{await f.command('late.arm',{});pending=Promise.allSettled([f.command('plugins.configure',{pluginId:'late-write-probe',config:{}})]);let state;const end=Date.now()+5000;do{state=await(await f.query('cleanup.status')).json();if(state.result)break;await new Promise(resolve=>setTimeout(resolve,20));}while(Date.now()<end);expect(state).toMatchObject({held:true,result:{written:false,code:'PLUGIN_STOPPED'}});await f.command('cleanup.release',{});await pending;await f.refreshBootstrap();expect(await(await f.query('late.records')).json()).toEqual([]);}
finally{await f.command('cleanup.release',{}).catch(()=>{});await pending;await f.close();}

});
