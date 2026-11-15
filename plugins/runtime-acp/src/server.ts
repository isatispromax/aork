import {z} from 'zod';
import { TOOLS_SERVICE } from '@aork/contracts/tools';
import type {ToolsService,RunToolHandle} from '@aork/contracts/tools';
import {WORKSPACE_RUN_FILES} from '@aork/contracts/workspace';
import type {WorkspaceRunFiles,WorkspaceRunAuthority} from '@aork/contracts/workspace';
import type {OwnerDescriptor} from '@aork/sdk/server';
import { release } from 'node:os';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { AorkError, isAorkError } from '@aork/sdk';
import type { ServerPluginContext } from '@aork/sdk/server';
import { RUNNER_SERVICE } from '@aork/contracts/runner';
import type { LocalRunner, ManagedProcess } from '@aork/contracts/runner';
import { WORKSPACE_SERVICE } from '@aork/contracts/workspace';
import type { WorkspaceService } from '@aork/contracts/workspace';
import { AGENT_PROFILES_SERVICE } from '@aork/contracts/agent';
import type { AgentProfilesService } from '@aork/contracts/agent';
import { ACP_RUNTIME, runtimeFactSchema, runSchema } from '@aork/contracts/runtime';
import type { AcpRuntime, RuntimeRun } from '@aork/contracts/runtime';
import { boundedIngress } from './ingress.js';
import { turnEngine } from './turns.js';
import { operationRepository } from './persistence/repository.js';
import type { Operation } from './persistence/repository.js';
export { persistence } from './persistence/repository.js';

/** Runtime alone owns ACP. Only initialize and new are dispatched in this ticket. */
export function activate(context:ServerPluginContext){
  const repository=operationRepository(context.repository);
  const tools=context.service<ToolsService>(TOOLS_SERVICE);
  const runFiles=context.service<WorkspaceRunFiles>(WORKSPACE_RUN_FILES);
  const authorities=new Map<string,WorkspaceRunAuthority>();
  const selectedSessions=(consumer:OwnerDescriptor,owner:OwnerDescriptor)=>{context.verifyOwner(consumer);context.verifyOwner(owner);const selected=context.owner.serviceOwners['aork.sessions@1'];if(consumer.pluginId!==owner.pluginId||consumer.version!==owner.version||consumer.hostEpoch!==owner.hostEpoch||consumer.pluginId!==selected?.pluginId||consumer.version!==selected.version)throw new AorkError('RUN_OWNER_INVALID','Only the actual selected Session lifecycle consumer may mutate a Run',403);};
  const workspaces=context.service<WorkspaceService>(WORKSPACE_SERVICE);
  const profiles=context.service<AgentProfilesService>(AGENT_PROFILES_SERVICE);
  const runner=context.service<LocalRunner>(RUNNER_SERVICE);
  const facts=context.factStream('runs',runtimeFactSchema);
  let closing=false; let admissionClosed=0; let admissions=0;
  const live=new Map<string,{process?:ManagedProcess;tools?:RunToolHandle;close?:()=>void;task:Promise<void>;stopping:boolean;stopTask?:Promise<void>;outcome?:{confirmed:boolean;reason?:string}}>();
  const turns=turnEngine(context,repository,()=>!closing&&!admissionClosed);
  const terminal=(operation:Operation)=>operation.state==='stopped'||operation.state==='unknown';
  const publish=(operation:Operation,state:RuntimeRun['state'],details:Partial<RuntimeRun>={})=>context.transactions.run(tx=>{
    const current=repository.get(operation.launch.run.runId,tx);if(!current||current.launch.run.generation!==operation.launch.run.generation||current.launch.run.hostEpoch!==operation.launch.run.hostEpoch)return;
    if(current.state==='stopped'||current.state==='unknown')return;
    if(state==='ready'&&current.stopRequested)return;
    repository.update(tx,{...current,state:state==='starting'?'attempting':state});
    facts.append(tx,current.launch.run.runId,{runId:current.launch.run.runId,generation:current.launch.run.generation,hostEpoch:current.launch.run.hostEpoch,state,details});
  });
  // Before any listener/admission: fence attempts from an earlier Host. Never replay or signal stored PIDs.
  context.transactions.run(tx=>{for(const op of repository.list(tx))if(!terminal(op)&&op.launch.run.hostEpoch!==context.owner.hostEpoch){repository.update(tx,{...op,state:'unknown'});facts.append(tx,op.launch.run.runId,{runId:op.launch.run.runId,generation:op.launch.run.generation,hostEpoch:op.launch.run.hostEpoch,state:'unknown',details:{reason:'Previous Host execution is uncertain; dispatch is paused and the Workspace remains blocked.'}});}});
  function attempting(op:Operation,attempt:Operation['attempt']){
    return context.transactions.run(tx=>{const current=repository.get(op.launch.run.runId,tx);if(!current||terminal(current)||current.stopRequested||closing)throw new AorkError('RUN_STOPPING','Run is stopping',409);repository.update(tx,{...current,state:'attempting',...(attempt?{attempt}:{})});});
  }
  function stop(op:Operation,owned:NonNullable<ReturnType<typeof live.get>>,reason?:string){
    if(owned.stopTask)return owned.stopTask;owned.stopping=true;
    try{context.transactions.run(tx=>{const current=repository.get(op.launch.run.runId,tx);if(current&&!terminal(current))repository.update(tx,{...current,state:'stopping',attempt:'stop'});});}catch{/* A storage failure still requires stopping the live owned group; it never authorizes Claim release. */}
    const stopReason=reason??'Run ended; managed execution was stopped.';owned.tools?.revoke();const authority=authorities.get(op.launch.run.runId);if(authority){runFiles.close(authority);authorities.delete(op.launch.run.runId);}try{context.transactions.run(tx=>tools.revokeInTransaction(tx,op.launch.run,'run-ended'));}catch{}turns.revoke(op.launch.run.runId,stopReason);owned.close?.();
    owned.stopTask=(async()=>{
    let confirmed=false;try{confirmed=owned.process?(await owned.process.stop()).confirmed:!owned.tools;}catch{}
    // A bounded process stop can return unknown while a real Host writer is still pending.
    // Never await that drain without a bound here or publish stopped from abort alone.
    if(confirmed){try{await owned.tools?.drain();const authority=authorities.get(op.launch.run.runId);if(authority){runFiles.close(authority);authorities.delete(op.launch.run.runId);}}catch{confirmed=false;}}
    await turns.stopped(op.launch.run.runId,confirmed,stopReason);
    owned.outcome={confirmed,...(reason?{reason}:{})};
    try{publish(op,confirmed?'stopped':'unknown',confirmed?(reason?{reason}:{}):{reason:'Managed process group or registered work could not be confirmed stopped; Workspace remains blocked.'});if(confirmed)live.delete(op.launch.run.runId);}catch{/* Revoked ordinary callbacks cannot write. The joined owned teardown retries this outcome in its cleanup scope. */}
    })();return owned.stopTask;
  }
  async function start(op:Operation,owned:NonNullable<ReturnType<typeof live.get>>){
    let phase='process launch';
    try{
      if((await workspaces.inspectDirectory(op.launch.workspace.id)).status!=='available')throw new AorkError('WORKSPACE_DIRECTORY_CHANGED','Registered directory changed before process launch',409);
      attempting(op,'spawn');
      const environment:Record<string,string>={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'C.UTF-8'};
      owned.process=runner.spawn(context.owner,{executable:op.launch.agent.launch.executable,arguments:op.launch.agent.launch.arguments,cwd:op.launch.workspace.directory,environment});
      context.transactions.run(tx=>{const current=repository.get(op.launch.run.runId,tx)!;repository.update(tx,{...current,processIdentity:owned.process!.identity});});
      const closeProtocol=(reason:string)=>{turns.revoke(op.launch.run.runId,reason);owned.close?.();return stop(op,owned,reason);};
      const wire=boundedIngress(acp.ndJsonStream(Writable.toWeb(owned.process.stdin),Readable.toWeb(owned.process.stdout) as ReadableStream<Uint8Array>,{maxMessageBytes:1024*1024}),reason=>{void closeProtocol(reason).catch(()=>{});},{before:(id,message)=>turns.beforeResponse(op,id,message),written:(id,success)=>turns.responseWritten(op,id,success)});
      const connection=acp.client().onNotification(acp.methods.client.session.update,({params})=>turns.update(op,params)).onRequest(acp.methods.client.session.requestPermission,ctx=>turns.permission(op,ctx,closeProtocol)).connect(wire);
      owned.close=()=>connection.close();
      const bounded=async<T>(operation:Promise<T>)=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{connection.close();reject(new AorkError('ACP_TIMEOUT','Agent setup did not finish',409));},5000);})]);}finally{if(timer)clearTimeout(timer);}};
      phase='ACP initialization';attempting(op,'initialize');
      const initialized=await bounded(connection.agent.request(acp.methods.agent.initialize,{protocolVersion:acp.PROTOCOL_VERSION,clientInfo:{name:'aork',version:'0.1.0'},clientCapabilities:{}}));
      if(initialized.protocolVersion!==acp.PROTOCOL_VERSION)throw new AorkError('ACP_PROTOCOL_UNSUPPORTED','Agent did not negotiate the supported ACP protocol',409);
      phase='tool bridge setup';
      if(op.launch.toolSnapshot){const authority=authorities.get(op.launch.run.runId);if(!authority)throw new AorkError('WORKSPACE_AUTHORITY_INVALID','Run admission authority is unavailable',409);owned.tools=await tools.openRun(op.launch.toolSnapshot,{registerJob:cancel=>owned.process!.registerJob(cancel),currentScope:()=>{const current=repository.get(op.launch.run.runId);const prompt=repository.prompts().find(prompt=>prompt.runId===op.launch.run.runId&&['attempting','running'].includes(prompt.state));return{ready:!owned.stopping&&!closing&&current?.state==='ready'&&!current.stopRequested,...(prompt?{turnId:prompt.turnId}:{})};},onFailure:()=>{void stop(op,owned,'Tool bridge authorization ended; managed execution was stopped.').catch(()=>{});}},authority);}
      phase='native Session creation';attempting(op,'session.new');
      const native=z.object({sessionId:z.string().min(1).max(500)}).passthrough().parse(await bounded(connection.agent.request(acp.methods.agent.session.new,{cwd:op.launch.workspace.directory,mcpServers:owned.tools?.descriptor?[{name:'aork',...owned.tools.descriptor}]:[]})));
      turns.ready(op,connection.agent,native.sessionId,reason=>stop(op,owned,reason));
      publish(op,'ready',{processIdentity:owned.process.identity,protocolVersion:initialized.protocolVersion,...(initialized.agentInfo?.version!==undefined?{agentVersion:initialized.agentInfo.version}:{}),...(initialized.agentInfo?.name!==undefined?{agentName:initialized.agentInfo.name}:{}),nativeSessionId:native.sessionId,stateReference:op.launch.agent.profile.stateDirectory,loadSession:initialized.agentCapabilities?.loadSession===true});
      // Unexpected connection/leader exit is not process-tree stop proof. The actual owned group is stopped first.
      void Promise.race([connection.closed,owned.process.exited]).then(async()=>{const current=repository.get(op.launch.run.runId);if(current&&!terminal(current)&&!owned.stopping)await stop(op,owned,'Agent connection or managed process exited; managed execution was stopped.');}).catch(()=>{});
    }catch{await stop(op,owned,`${phase} failed or was interrupted; managed execution was stopped.`);}
  }
  function dispatch(){if(closing)return;for(const [id,authority] of authorities)if(!repository.get(id)){runFiles.close(authority);authorities.delete(id);}for(const prompt of repository.prompts())if(prompt.cancelRequested)live.get(prompt.runId)?.tools?.cancelTurn(prompt.turnId);turns.tick();for(const op of repository.active()){
    if(op.launch.run.hostEpoch!==context.owner.hostEpoch||terminal(op))continue;
    let owned=live.get(op.launch.run.runId);
    if(!owned&&op.state==='pending'){
      owned={task:Promise.resolve(),stopping:false};live.set(op.launch.run.runId,owned);
      const target=owned;target.task=start(op,target).catch(()=>{try{publish(op,'unknown',{reason:'Runtime persistence or cleanup failed; Workspace remains blocked.'});}catch{}});
    }
    if(op.stopRequested&&owned&&!owned.stopping){const target=owned;const prior=target.task;target.task=(async()=>{turns.revoke(op.launch.run.runId,'Run ended; managed execution was stopped.');target.close?.();await prior;await stop(op,target);})().catch(()=>{});}
  }}
  function flushTerminalOutcomes(){
    turns.flushStopped();
    for(const [runId,owned] of live){const op=repository.get(runId);if(op&&!terminal(op)&&owned.outcome){const {confirmed,reason}=owned.outcome;publish(op,confirmed?'stopped':'unknown',confirmed?(reason?{reason}:{}):{reason:'Managed process group or registered work could not be confirmed stopped; Workspace remains blocked.'});if(confirmed)live.delete(runId);}}
    for(const op of repository.active())if(op.launch.run.hostEpoch===context.owner.hostEpoch&&!live.has(op.launch.run.runId)){const authority=authorities.get(op.launch.run.runId);if(authority){runFiles.close(authority);authorities.delete(op.launch.run.runId);}publish(op,op.state==='pending'?'stopped':'unknown',{reason:'No live execution handle remains; prior effects are not replayed.'});}
  }
  let shutdownTask:Promise<void>|undefined;
  const service:AcpRuntime={facts:facts.source,turnFacts:turns.facts,permissionFacts:turns.permissions,versions:Object.freeze({nodeVersion:process.versions.node,acpSdkVersion:'2.7.0',platform:process.platform,osRelease:release()}),environmentNames:Object.freeze(process.platform==='darwin'?['PATH','LANG','__CF_USER_TEXT_ENCODING']:['PATH','LANG']),
    async withAdmission(ids,operation){if(closing||admissionClosed)throw new AorkError('RUN_ADMISSION_CLOSED','Run admission is closed for a Plugin change',409);admissions++;try{return await operation();}finally{admissions--;}},
    acceptStart(tx,launch){runSchema.parse(launch.run);if(launch.run.state!=='starting'||launch.run.hostEpoch!==launch.owner.hostEpoch||launch.run.profileRevision!==launch.agent.profile.revision)throw new AorkError('RUN_CONTEXT_INVALID','Run needs a current starting generation and its captured Profile',409);context.verifyOwner(launch.owner);workspaces.verifyClaim(tx,launch.claim,launch.owner,launch.run.runId,launch.workspace.id);profiles.validateLaunch(launch.agent,tx);const registered=workspaces.requireOpenWorkspace(launch.workspace.id,tx);if(registered.directory!==launch.workspace.directory||launch.run.directory!==registered.directory||launch.run.pluginGraphHash!==context.owner.pluginGraphHash)throw new AorkError('RUN_CONTEXT_INVALID','Run launch no longer matches its current Workspace and Host graph',409);if(launch.owner.serviceOwners['aork.sessions@1']?.pluginId!==launch.owner.pluginId)throw new AorkError('RUN_OWNER_INVALID','Only the selected Session lifecycle owner can admit a Run',409);if(closing||admissionClosed||!admissions||launch.run.hostEpoch!==context.owner.hostEpoch)throw new AorkError('RUN_ADMISSION_CLOSED','Run admission is closed',409);if(launch.toolSnapshot)tools.assertCaptured(tx,launch.toolSnapshot);
      const authority=runFiles.bindRunAuthority(tx,launch.claim,launch.owner,launch.run,launch.workspace.id);authorities.set(launch.run.runId,authority);
      const {claim:_permit,...snapshot}=launch;repository.insert(tx,{launch:snapshot,state:'pending',stopRequested:false});},
    acceptPrompt:(tx,owner,input)=>turns.accept(tx,owner,input),
    acceptCancel:(tx,owner,turnId)=>turns.cancel(tx,owner,turnId),
    acceptResponse:(tx,owner,principal,interaction,optionId)=>turns.response(tx,owner,principal,interaction,optionId),
    acceptStop(tx,owner,runId,generation){context.verifyOwner(owner);const op=repository.get(runId,tx);if(!op||op.launch.owner.pluginId!==owner.pluginId||op.launch.run.generation!==generation)throw new AorkError('RUN_UNAVAILABLE','Run is unavailable',404);if(op.launch.run.hostEpoch!==context.owner.hostEpoch||op.state==='unknown')throw new AorkError('RUN_OWNERSHIP_UNKNOWN','This Run has no live owned process handle; use local maintenance',409);if(op.state==='stopped')return;tools.revokeInTransaction(tx,op.launch.run,'user-ended');repository.update(tx,{...op,stopRequested:true,state:op.state==='pending'?'pending':'stopping'});},
    shutdown(){
      if(!shutdownTask){closing=true;shutdownTask=(async()=>{clearInterval(timer);for(const [runId,owned] of live){turns.revoke(runId,'Host shutdown stopped managed execution.');owned.close?.();}await Promise.all([...live.entries()].map(async([runId,owned])=>{await owned.task;const op=repository.get(runId);if(op&&!terminal(op))await stop(op,owned,'Host shutdown stopped managed execution.');}));await turns.drain();})();}
      // Each caller attaches its own flush, rather than caching the first
      // caller's cleanup authority together with the physical stop task.
      return shutdownTask.then(()=>{try{flushTerminalOutcomes();}catch(error){if(!isAorkError(error)||error.code!=='PLUGIN_STOPPED')throw error;}});
    },
  };
  context.lifecycleGuard({acquireChange(affected){admissionClosed++;const relevant=repository.list().filter(op=>!terminal(op)||op.state==='unknown').filter(op=>op.launch.run.usedPluginIds.some(id=>affected.includes(id)));return{state:relevant.some(op=>op.state==='unknown')?'unknown':admissions||relevant.length?'busy':'idle',release(){admissionClosed--;}};}});
  context.provideScoped<AcpRuntime>(ACP_RUNTIME,consumer=>({...service,
    withAdmission(ids,operation){selectedSessions(consumer,consumer);return service.withAdmission(ids,operation);},
    acceptStart(tx,launch){selectedSessions(consumer,launch.owner);service.acceptStart(tx,launch);},
    acceptStop(tx,owner,id,generation){selectedSessions(consumer,owner);service.acceptStop(tx,owner,id,generation);},
    acceptPrompt(tx,owner,input){selectedSessions(consumer,owner);service.acceptPrompt(tx,owner,input);},
    acceptCancel(tx,owner,id){selectedSessions(consumer,owner);service.acceptCancel(tx,owner,id);},
    acceptResponse(tx,owner,principal,interaction,option){context.verifyOwner(consumer);if(consumer.pluginId!==owner.pluginId||consumer.version!==owner.version||consumer.hostEpoch!==owner.hostEpoch||consumer.pluginId!==context.owner.serviceOwners['aork.interactions@1']?.pluginId)throw new AorkError('RUN_OWNER_INVALID','Only the selected Interactions consumer may respond',403);service.acceptResponse(tx,owner,principal,interaction,option);},
  }));
  const timer=setInterval(dispatch,20);context.effect(()=>async()=>{try{await service.shutdown();}finally{flushTerminalOutcomes();}});
}
