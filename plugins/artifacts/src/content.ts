import { constants } from 'node:fs';
import { mkdir, chmod, lstat, realpath, open, rename, unlink, rmdir, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { AorkError } from '@aork/sdk';
import { ARTIFACT_LIMITS } from '@aork/contracts/artifact';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const corrupt=()=>new AorkError('ARTIFACT_CONTENT_UNAVAILABLE','Saved content is missing, changed, or not a regular private file',409);
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const same=(a:Awaited<ReturnType<typeof lstat>>,b:Awaited<ReturnType<typeof lstat>>)=>a.dev===b.dev&&a.ino===b.ino;
export async function createContentStore(stateDirectory:string){
 await mkdir(stateDirectory,{recursive:true,mode:0o700});
 const state=await lstat(stateDirectory);if(!state.isDirectory()||state.isSymbolicLink()||await realpath(stateDirectory)!==stateDirectory)throw corrupt();
 await chmod(stateDirectory,0o700);
 const root=join(stateDirectory,'content');try{await mkdir(root,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
 const identity=await lstat(root);if(!identity.isDirectory()||identity.isSymbolicLink()||await realpath(root)!==root)throw corrupt();await chmod(root,0o700);
 async function checkRoot(){const current=await lstat(root);const parent=await lstat(stateDirectory);if(!same(state,parent)||!parent.isDirectory()||parent.isSymbolicLink()||await realpath(stateDirectory)!==stateDirectory||!same(identity,current)||!current.isDirectory()||current.isSymbolicLink()||await realpath(root)!==root)throw corrupt();}
 async function contentDirectory(id:string){if(!uuid.test(id))throw corrupt();await checkRoot();const directory=join(root,id);const facts=await lstat(directory);if(!facts.isDirectory()||facts.isSymbolicLink()||(facts.mode&0o077)!==0||await realpath(directory)!==directory)throw corrupt();return directory;}
 async function read(id:string,expected:{size:number;sha256:string}){
  const directory=await contentDirectory(id);const path=join(directory,'bytes');const facts=await lstat(path);if(!facts.isFile()||facts.isSymbolicLink()||facts.size!==expected.size||facts.size>ARTIFACT_LIMITS.transferBytes||(facts.mode&0o077)!==0)throw corrupt();
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const before=await handle.stat();if(!before.isFile()||!same(facts,before))throw corrupt();const bytes=Buffer.alloc(expected.size);let offset=0;while(offset<bytes.length){const chunk=await handle.read(bytes,offset,bytes.length-offset,offset);if(!chunk.bytesRead)throw corrupt();offset+=chunk.bytesRead;}const extra=Buffer.alloc(1);if((await handle.read(extra,0,1,offset)).bytesRead)throw corrupt();const after=await handle.stat();const final=await lstat(path);await checkRoot();if(!same(before,after)||!same(after,final)||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||hash(bytes)!==expected.sha256)throw corrupt();return bytes;}finally{await handle.close();}
 }
 async function remove(id:string){const directory=await contentDirectory(id);const entries=[];for await(const entry of await opendir(directory)){if(!['staged','bytes'].includes(entry.name)||!entry.isFile()||entry.isSymbolicLink())throw corrupt();entries.push(entry.name);}for(const name of entries){await checkRoot();const facts=await lstat(join(directory,name));if(!facts.isFile()||facts.isSymbolicLink())throw corrupt();await unlink(join(directory,name));}await checkRoot();await rmdir(directory);}
 return{
  read,remove,
  async publish(bytes:Uint8Array){if(bytes.byteLength>ARTIFACT_LIMITS.transferBytes)throw new AorkError('ARTIFACT_TOO_LARGE','Capture exceeds 8 MiB',413);await checkRoot();const contentId=randomUUID();const directory=join(root,contentId);await mkdir(directory,{mode:0o700});const path=join(directory,'staged');try{const handle=await open(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);try{let offset=0;while(offset<bytes.length){const result=await handle.write(bytes,offset,bytes.length-offset,offset);if(!result.bytesWritten)throw new AorkError('ARTIFACT_WRITE_INCOMPLETE','Content could not be completely written',503);offset+=result.bytesWritten;}await handle.sync();}finally{await handle.close();}const expected={size:bytes.byteLength,sha256:hash(bytes)};const staged=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const facts=await staged.stat();if(!facts.isFile()||facts.size!==expected.size||hash(await staged.readFile())!==expected.sha256)throw corrupt();}finally{await staged.close();}await checkRoot();await rename(path,join(directory,'bytes'));const dir=await open(directory,constants.O_RDONLY|constants.O_NOFOLLOW);try{await dir.sync();}finally{await dir.close();}await read(contentId,expected);return{contentId,...expected};}catch(error){try{await remove(contentId);}catch(cleanupError){console.error('Artifact staging cleanup failed',contentId,cleanupError instanceof Error?cleanupError.message:'unknown');}throw error;}},
  async page(after=''){await checkRoot();const ids:string[]=[];for await(const entry of await opendir(root)){if(uuid.test(entry.name)&&entry.name>after&&entry.isDirectory()&&!entry.isSymbolicLink()){ids.push(entry.name);ids.sort();if(ids.length>ARTIFACT_LIMITS.pageRows+1)ids.pop();}}return{ids:ids.slice(0,ARTIFACT_LIMITS.pageRows),next:ids.length>ARTIFACT_LIMITS.pageRows?ids[ARTIFACT_LIMITS.pageRows-1]!:null};},
 };
}
