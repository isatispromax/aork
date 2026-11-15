// Fixture-only scheduling boundary. Production APIs and real FileHandle operations are unchanged.
import promises from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
const control=new URL(import.meta.url).searchParams.get('control');
const originalOpen=promises.open;
promises.open=async function(...args){
 const handle=await originalOpen.apply(this,args);
 if(!control||!existsSync(join(control,'workspace.json')))return handle;
 const {root}=JSON.parse(readFileSync(join(control,'workspace.json'),'utf8'));
 if(typeof args[0]!=='string'||!args[0].startsWith(root+'/')||!args[0].split('/').at(-1).startsWith('.aork-upload-')||existsSync(join(control,'entered')))return handle;
 const originalWrite=handle.write;
 handle.write=async function(...writeArgs){
  const actual=originalWrite.apply(this,writeArgs);writeFileSync(join(control,'entered'),'actual FileHandle.write invoked');
  let value;let failure;try{value=await actual;}catch(error){failure=error;}writeFileSync(join(control,'native-settled'),'actual operation settled');
  while(!existsSync(join(control,'release')))await pause(5);
  if(failure)throw failure;return value;
 };
 return handle;
};
syncBuiltinESMExports();
