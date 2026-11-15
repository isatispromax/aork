import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionHost } from './session-host.js';

export async function snapshotHost(projection = false) {
  return sessionHost(false, async ({ distributionDir, profile }) => {
    const directory = join(distributionDir, 'plugins/snapshot-fixture/0.1.0');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'aork.plugin.json'), JSON.stringify({ manifestVersion: 1, id: 'snapshot-fixture', version: '0.1.0', sdkRange: '^0.1.0', server: 'server.js', client: 'client.js', provides:['fixture.source@1'], ui: { providers: [{id:'detail',contract:'aork.workbench.home@1'},{id:'layout',contract:'aork.workbench.layout@1'}] } }));
    await writeFile(join(directory, 'server.js'), `export const persistence={namespace:'plugin_snapshot_hfixture__',migrations:[{version:1,statements:['CREATE TABLE plugin_snapshot_hfixture__items (id TEXT PRIMARY KEY, principal TEXT NOT NULL)']}],statements:{insert:{sql:'INSERT INTO plugin_snapshot_hfixture__items (id,principal) VALUES (?,?)',mode:'write'},list:{sql:'SELECT id FROM plugin_snapshot_hfixture__items WHERE principal=? ORDER BY id',mode:'read'}}};
      export function activate(c){const schema={parse:v=>v};let saved;const events={'fixture.changed':{version:1,payload:schema}};c.provide('fixture.source@1',{list:principal=>c.repository.all('list',[principal])});c.snapshot('fixture.items',{maxBytes:65536,read(p,r,tx){saved=tx;return c.repository.all('list',[r.identity],tx);}});
      c.snapshot('fixture.write',{maxBytes:65536,read(p,r,tx){c.repository.run(tx,'insert',['forbidden',r.identity]);return[];}});
      c.snapshot('fixture.nestedWrite',{maxBytes:65536,read(p,r){c.transactions.run(tx=>c.repository.run(tx,'insert',['nested',r.identity]));return[];}});
      c.snapshot('fixture.async',{maxBytes:65536,read(){return Promise.resolve([]);}});
      c.query('fixture.expired',{access:'authenticated',execute:r=>c.repository.all('list',[r.identity],saved)});
      c.command('fixture.foreign',{access:'authenticated',execute(){c.transactions.run(tx=>c.publishEvents(tx,'another-principal',[{type:'fixture.changed',version:1,entityId:'private',payload:{id:'private'}}],events));return{};}});
      c.durableCommand('fixture.add',{version:1,payload:schema,result:schema,events,execute(p,_,tx,r){c.repository.run(tx,'insert',[p.id,r.identity]);return{result:{id:p.id},events:[{type:'fixture.changed',version:1,entityId:p.id,payload:{id:p.id}}]};}});
      c.durableCommand('fixture.burst',{version:1,payload:{parse(v){if(!Number.isInteger(v.count)||v.count<1||v.count>2050)throw Error();return v;}},result:schema,events,execute(p,_,tx,r){const changes=[];for(let i=0;i<p.count;i++){const id=p.prefix+i;c.repository.run(tx,'insert',[id,r.identity]);changes.push({type:'fixture.changed',version:1,entityId:id,payload:{id}});}return{result:{count:p.count},events:changes};}});}`);
    await writeFile(join(directory, 'client.js'), `import{createElement as h,useEffect,useState,useRef}from'react';export function activate(c){c.registerView('layout',({runtime})=>h('main',null,runtime.renderView('aork.workbench.home@1'),runtime.renderView('aork.auth.controls@1')));c.registerView('detail',function({runtime}){const[items,setItems]=useState([]);const[error,setError]=useState('');const fail=useRef(false);useEffect(()=>runtime.observeSnapshot('${projection?'projection.items':'fixture.items'}',{}, {next(value){if(fail.current){fail.current=false;throw new Error('Controlled application failure');}setItems(value);setError('');},error(e){setError(e.message);}}, {owners:['${projection?'projection-fixture':'snapshot-fixture'}']}),[runtime]);return h('section',{'aria-label':'Independent saved items'},h('output',{'data-testid':'saved-items'},JSON.stringify(items)),h('p',{'role':'status'},error),h('button',{onClick(){fail.current=true;}},'Fail next application'));});}`);
    profile.ui.providers['aork.workbench.home@1']='snapshot-fixture:detail';profile.ui.providers['aork.workbench.layout@1']='snapshot-fixture:layout';
    profile.plugins.push({ id: 'snapshot-fixture', version: '0.1.0', enabled: true });
    if(projection){
      const projected=join(distributionDir,'plugins/projection-fixture/0.1.0');await mkdir(projected,{recursive:true});
      await writeFile(join(projected,'aork.plugin.json'),JSON.stringify({manifestVersion:1,id:'projection-fixture',version:'0.1.0',sdkRange:'^0.1.0',server:'server.js',requires:['fixture.source@1'],ui:{providers:[]}}));
      await writeFile(join(projected,'server.js'),`export const persistence={namespace:'plugin_projection_hfixture__',migrations:[{version:1,statements:['CREATE TABLE plugin_projection_hfixture__items(id TEXT PRIMARY KEY,principal TEXT NOT NULL)']}],statements:{insert:{sql:'INSERT OR IGNORE INTO plugin_projection_hfixture__items(id,principal) VALUES(?,?)',mode:'write'},list:{sql:'SELECT id FROM plugin_projection_hfixture__items WHERE principal=? ORDER BY id',mode:'read'}}};export function activate(c){const schema={parse:v=>v};c.snapshot('projection.items',{maxBytes:65536,read(p,r,tx){return c.repository.all('list',[r.identity],tx);}});c.command('projection.release',{access:'authenticated',execute(p,r){const items=c.service('fixture.source@1').list(r.identity);c.transactions.run(tx=>{for(const item of items)c.repository.run(tx,'insert',[item.id,r.identity]);c.publishEvents(tx,r.identity,[{type:'projection.changed',version:1,entityId:'items',payload:{}}],{'projection.changed':{version:1,payload:schema}});});return{projected:items.length};}});}`);
      profile.plugins.push({id:'projection-fixture',version:'0.1.0',enabled:true});
    }
  });
}
