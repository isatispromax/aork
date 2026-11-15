import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionHost } from './session-host.js';

export async function snapshotHost() {
  return sessionHost(false, async ({ distributionDir, profile }) => {
    const directory = join(distributionDir, 'plugins/snapshot-fixture/0.1.0');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'aork.plugin.json'), JSON.stringify({ manifestVersion: 1, id: 'snapshot-fixture', version: '0.1.0', sdkRange: '^0.1.0', server: 'server.js', client: 'client.js', ui: { providers: [{id:'detail',contract:'aork.workbench.home@1'}] } }));
    await writeFile(join(directory, 'server.js'), `export const persistence={namespace:'plugin_snapshot_hfixture__',migrations:[{version:1,statements:['CREATE TABLE plugin_snapshot_hfixture__items (id TEXT PRIMARY KEY, principal TEXT NOT NULL)']}],statements:{insert:{sql:'INSERT INTO plugin_snapshot_hfixture__items (id,principal) VALUES (?,?)',mode:'write'},list:{sql:'SELECT id FROM plugin_snapshot_hfixture__items WHERE principal=? ORDER BY id',mode:'read'}}};
      export function activate(c){const schema={parse:v=>v};c.snapshot('fixture.items',{maxBytes:65536,read(p,r,tx){return c.repository.all('list',[r.identity],tx);}});c.durableCommand('fixture.add',{version:1,payload:schema,result:schema,events:{'fixture.changed':{version:1,payload:schema}},execute(p,_,tx,r){c.repository.run(tx,'insert',[p.id,r.identity]);return{result:{id:p.id},events:[{type:'fixture.changed',version:1,entityId:p.id,payload:{id:p.id}}]};}});}`);
    await writeFile(join(directory, 'client.js'), `import{createElement as h,useEffect,useState,useRef}from'react';export function activate(c){c.registerView('detail',function({runtime}){const[items,setItems]=useState([]);const[error,setError]=useState('');const fail=useRef(false);useEffect(()=>runtime.observeSnapshot('fixture.items',{}, {next(value){if(fail.current){fail.current=false;throw new Error('Controlled application failure');}setItems(value);setError('');},error(e){setError(e.message);}}, {owners:['snapshot-fixture']}),[runtime]);return h('section',{'aria-label':'Independent saved items'},h('output',{'data-testid':'saved-items'},JSON.stringify(items)),h('p',{'role':'status'},error),h('button',{onClick(){fail.current=true;}},'Fail next application'));});}`);
    profile.ui.providers['aork.workbench.home@1']='snapshot-fixture:detail';
    profile.plugins.push({ id: 'snapshot-fixture', version: '0.1.0', enabled: true });
  });
}
