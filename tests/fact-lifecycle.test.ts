import { expect, test } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { sessionHost } from './fixtures/session-host.js';
for(const largeCursor of [false,true])test(`facts published during reversible consumer suspension catch up exactly once${largeCursor?' above JavaScript integer precision':''}`,async()=>{
  const f=await sessionHost(false,async({distributionDir,profile})=>{
    for(const id of ['fact-producer','projection-consumer'])await mkdir(join(distributionDir,'plugins',id,'0.1.0'),{recursive:true});
    const producer=join(distributionDir,'plugins/fact-producer/0.1.0');
    await writeFile(join(producer,'aork.plugin.json'),JSON.stringify({manifestVersion:1,id:'fact-producer',version:'0.1.0',sdkRange:'^0.1.0',server:'server.js',provides:['fixture.facts@1'],ui:{providers:[]}}));
    await writeFile(join(producer,'server.js'),`export function activate(c){let refuse=false;c.command('facts.refuseChange',{access:'authenticated',execute(payload){refuse=payload.refuse;return{refuse};}});const stream=c.factStream('changes',{parse:v=>v});c.provide('fixture.facts@1',stream.source);c.lifecycleGuard({acquireChange(ids){if(ids.includes('projection-consumer'))c.transactions.run(tx=>stream.append(tx,'entry',{id:crypto.randomUUID()}));return{state:refuse?'busy':'idle',release(){}};}});}`);
    const consumer=join(distributionDir,'plugins/projection-consumer/0.1.0');
    await writeFile(join(consumer,'aork.plugin.json'),JSON.stringify({manifestVersion:1,id:'projection-consumer',version:'0.1.0',sdkRange:'^0.1.0',server:'server.js',requires:['fixture.facts@1'],ui:{providers:[]}}));
    await writeFile(join(consumer,'server.js'),`export const persistence={namespace:'plugin_projection_hconsumer__',migrations:[{version:1,statements:['CREATE TABLE plugin_projection_hconsumer__items (id TEXT PRIMARY KEY)']}],statements:{insert:{sql:'INSERT INTO plugin_projection_hconsumer__items (id) VALUES (?)',mode:'write'},list:{sql:'SELECT id FROM plugin_projection_hconsumer__items',mode:'read'}}};export function activate(c){c.consumeFacts(c.service('fixture.facts@1'),{id:'projection',events:{},apply(f,tx){c.repository.run(tx,'insert',[f.payload.id]);return{principal:'',events:[]};}});c.query('projection.items',{access:'authenticated',execute:()=>c.repository.all('list')});}`);
    profile.plugins.push({id:'fact-producer',version:'0.1.0',enabled:true},{id:'projection-consumer',version:'0.1.0',enabled:true});
  });
  try{
    if(largeCursor)await f.offlineRestore(async dataDir=>{
      // Restored-database input at SQLite's standard counter boundary. Assertions
      // below use the real Host's public projection, never private table reads.
      const database=new Database(join(dataDir,'aork.sqlite'));
      try{const result=database.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='internal_facts'").run(9007199254740992n);if(!result.changes)database.prepare('INSERT INTO sqlite_sequence(name,seq) VALUES (?,?)').run('internal_facts',9007199254740992n);}finally{database.close();}
    });
    expect(await(await f.query('projection.items')).json()).toEqual([]);
    expect((await f.command('facts.refuseChange',{refuse:true})).status).toBe(200);expect((await f.command('plugins.configure',{pluginId:'projection-consumer',config:{}})).status).toBe(409);expect(await(await f.query('projection.items')).json()).toHaveLength(1);expect((await f.command('facts.refuseChange',{refuse:false})).status).toBe(200);
    expect((await f.command('plugins.configure',{pluginId:'projection-consumer',config:{}})).status).toBe(200);await f.refreshBootstrap();
    const projected=await(await f.query('projection.items')).json();expect(projected).toHaveLength(2);
    await mkdir(join(f.directory,'after-projection'),{recursive:true});expect((await f.command('workspace.create',{workspace:{name:'Available',management:'external',directory:join(f.directory,'after-projection'),access:'read-write'}})).status).toBe(200);
    await f.restart();expect(await(await f.query('projection.items')).json()).toEqual(projected);
    await mkdir(join(f.directory,'after-restart'),{recursive:true});expect((await f.command('workspace.create',{workspace:{name:'Still available',management:'external',directory:join(f.directory,'after-restart'),access:'read-write'}})).status).toBe(200);
  }finally{await f.close();}
});
