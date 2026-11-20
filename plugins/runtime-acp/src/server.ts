import { TOOLS_SERVICE } from '@aork/contracts/tools';
import type {ToolsService,RunToolHandle} from '@aork/contracts/tools';
import {WORKSPACE_RUN_FILES} from '@aork/contracts/workspace';
import type {WorkspaceRunFiles,WorkspaceRunAuthority} from '@aork/contracts/workspace';
import type {OwnerDescriptor} from '@aork/sdk/server';
import type{NativeHistoryEntry}from'@aork/contracts/recovery';
import {nativeRecovery} from './recovery.js';

import { release } from 'node:os';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { AorkError, isAorkError } from '@aork/sdk';
import type { ServerPluginContext,SyncTransaction } from '@aork/sdk/server';
import { RUNNER_SERVICE, RUNNER_INSPECTION } from '@aork/contracts/runner';
import type { LocalRunner, ManagedProcess, RecordedProcessInspection } from '@aork/contracts/runner';
import { WORKSPACE_SERVICE } from '@aork/contracts/workspace';
import type { WorkspaceService } from '@aork/contracts/workspace';
import { AGENT_PROFILES_SERVICE, LAUNCH_ENVIRONMENT } from '@aork/contracts/agent';
import type { AgentProfilesService, LaunchEnvironmentGrant, LaunchEnvironmentService } from '@aork/contracts/agent';
import { ACP_RUNTIME, runtimeFactSchema, runSchema } from '@aork/contracts/runtime';
import type { AcpRuntime, RuntimeRun } from '@aork/contracts/runtime';
import { boundedIngress } from './ingress.js';
import { turnEngine } from './turns.js';
import { operationRepository } from './persistence/repository.js';
import type { Operation } from './persistence/repository.js';
import { negotiatedInput } from './negotiated.js';
import { configurationEngine } from './configuration.js';
import { EXECUTION_WRITERS, executionWriterSnapshotSchema, type ExecutionWriters } from '@aork/contracts/reconciliation';
import { provideReconciliation } from './reconciliation.js';
export { persistence } from './persistence/repository.js';

/** Runtime alone owns ACP. Only initialize and new are dispatched in this ticket. */
export function activate(context:ServerPluginContext){
  const repository=operationRepository(context.repository);
  const tools=context.service<ToolsService>(TOOLS_SERVICE);
  const runFiles=context.service<WorkspaceRunFiles>(WORKSPACE_RUN_FILES);
  // One launch-environment facade per graph generation: its grants live per binding,
  // so a graph change rebinds to the current owner and old one-use grants fail closed.
  let launchEnvironment:LaunchEnvironmentService=context.service<LaunchEnvironmentService>(LAUNCH_ENVIRONMENT);
  let launchEnvironmentGraph=context.owner.pluginGraphHash;
  const currentLaunchEnvironment=()=>{const graph=context.owner.pluginGraphHash;if(graph!==launchEnvironmentGraph){launchEnvironment=context.service<LaunchEnvironmentService>(LAUNCH_ENVIRONMENT);launchEnvironmentGraph=graph;}return launchEnvironment;};
  const authorities=new Map<string,WorkspaceRunAuthority>();
  const selectedSessions=(consumer:OwnerDescriptor,owner:OwnerDescriptor)=>{context.verifyOwner(consumer);context.verifyOwner(owner);const selected=context.owner.serviceOwners['aork.sessions@1'];if(consumer.pluginId!==owner.pluginId||consumer.version!==owner.version||consumer.hostEpoch!==owner.hostEpoch||consumer.pluginId!==selected?.pluginId||consumer.version!==selected.version)throw new AorkError('RUN_OWNER_INVALID','Only the actual selected Session lifecycle consumer may mutate a Run',403);};
  const selectedInteractions=(consumer:OwnerDescriptor,owner:OwnerDescriptor)=>{context.verifyOwner(consumer);context.verifyOwner(owner);const selected=context.owner.serviceOwners['aork.interactions@1'];if(consumer.pluginId!==owner.pluginId||consumer.version!==owner.version||consumer.hostEpoch!==owner.hostEpoch||consumer.pluginId!==selected?.pluginId||consumer.version!==selected.version)throw new AorkError('RUN_OWNER_INVALID','Only the actual selected Interactions consumer may respond',403);};
  const recovery=nativeRecovery(context,repository);

  const workspaces=context.service<WorkspaceService>(WORKSPACE_SERVICE);
  const profiles=context.service<AgentProfilesService>(AGENT_PROFILES_SERVICE);
  const runner=context.service<LocalRunner>(RUNNER_SERVICE);
  const facts=context.factStream('runs',runtimeFactSchema);
  let closing=false; let admissionClosed=0; let admissions=0;
  const live=new Map<string,{process?:ManagedProcess;tools?:RunToolHandle;close?:()=>void;task:Promise<void>;stopping:boolean;stopTask?:Promise<void>;outcome?:{confirmed:boolean;reason?:string}}>();
  // One-use in-memory launch environment grants from the Profiles owner. Never
  // persisted, replayed after restart, or exposed in facts, receipts or errors.
  const grants=new Map<string,{grant:LaunchEnvironmentGrant;generation:number;hostEpoch:string}>();
  const turns=turnEngine(context,repository,()=>!closing&&!admissionClosed);
  const terminal=(operation:Operation)=>operation.state==='stopped'||operation.state==='unknown';
  function reconcileToolGrant(tx:import('@aork/sdk/server').SyncTransaction,operation:Operation){
    try{tools.revokeInTransaction(tx,operation.launch.run,'run-terminal');}
    catch(error){
      // Global shutdown revokes descriptors and closes ordinary cross-owner writes.
      // The selected-caller gate stays intact; Tools reconciles in its own cleanup scope.
      if(closing&&isAorkError(error)&&(error.code==='OWNER_INVALID'||error.code==='PLUGIN_STOPPED'))return;
      throw error;
    }
  }
  const publish=(operation:Operation,state:RuntimeRun['state'],details:Partial<RuntimeRun>|((current:Operation)=>Partial<RuntimeRun>)={},complete?: (tx:SyncTransaction)=>void)=>context.transactions.run(tx=>{
    const current=repository.get(operation.launch.run.runId,tx);if(!current||current.launch.run.generation!==operation.launch.run.generation||current.launch.run.hostEpoch!==operation.launch.run.hostEpoch)return;
    if(current.state==='stopped'||current.state==='unknown')return;
    if(state==='ready'&&(current.stopRequested||current.state==='stopping'||closing))return;
    if(state==='stopped'||state==='unknown')reconcileToolGrant(tx,current);
    const applied=typeof details==='function'?details(current):details;const updated={...current.launch.run,...applied,state,...(applied.nativeSessionId?{nativeBound:true}:{})};
    const{nativeSessionId:_privateNative,stateReference:_privateState,...display}=applied;
    complete?.(tx);
    repository.update(tx,{...current,...(state==='unknown'&&!current.interruption?{interruption:{state:current.state,...(current.attempt?{attempt:current.attempt}:{})}}:{}),state:state==='starting'?'attempting':state,launch:{...current.launch,run:updated}});
    facts.append(tx,current.launch.run.runId,{runId:current.launch.run.runId,generation:current.launch.run.generation,hostEpoch:current.launch.run.hostEpoch,state,details:{...display,...(applied.nativeSessionId?{nativeBound:true}:{})}});return updated;

  });
  const configurations=configurationEngine(context,repository,publish);
  // Before any listener/admission: fence attempts from an earlier Host. Never replay or signal stored PIDs.
  context.transactions.run(tx=>{for(const op of repository.list(tx))if(!terminal(op)&&op.launch.run.hostEpoch!==context.owner.hostEpoch){const intent=op.launch.run.configuration;const configuration=intent&&['accepted','dispatching'].includes(intent.state)?{...intent,state:intent.state==='accepted'?'failed' as const:'delivery_unknown' as const,reason:'Host restarted before a definitive configuration result; no configuration is automatically resent.'}:intent;repository.update(tx,{...op,interruption:op.interruption??{state:op.state,...(op.attempt?{attempt:op.attempt}:{})},state:'unknown',launch:{...op.launch,run:{...op.launch.run,...(configuration?{configuration}:{})}}});facts.append(tx,op.launch.run.runId,{runId:op.launch.run.runId,generation:op.launch.run.generation,hostEpoch:op.launch.run.hostEpoch,state:'unknown',details:{...(configuration?{configuration}:{}),reason:'Previous Host execution is uncertain; dispatch is paused and the Workspace remains blocked.'}});}});
  function attempting(op:Operation,attempt:Operation['attempt']){
    return context.transactions.run(tx=>{const current=repository.get(op.launch.run.runId,tx);if(!current||terminal(current)||current.stopRequested||closing)throw new AorkError('RUN_STOPPING','Run is stopping',409);repository.update(tx,{...current,state:'attempting',...(attempt?{attempt}:{})});});
  }
  async function participantStopped(runId:string):Promise<boolean>{
    const op=repository.get(runId);if(!op)return false;
    if(op.writers?.participantRequired===false)return true;
    const captured=op.writers?.participant;const selected=context.owner.serviceOwners[EXECUTION_WRITERS];
    if(!captured||!selected||captured.owner.pluginId!==selected.pluginId||captured.owner.version!==selected.version)return false;
    // Resolve the facade per call: a graph change rebinds it to the current owner,
    // and an owned cleanup may still resolve its declared services for terminal proof.
    const writers=context.service<ExecutionWriters>(EXECUTION_WRITERS);
    const record=JSON.stringify(op);const graph=context.owner.pluginGraphHash;
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const prepared=await Promise.race([writers.prepare(op.launch.run,captured),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new AorkError('RUN_WRITERS_UNAVAILABLE','Managed writer observation did not finish',409)),2000);})]);
      return context.transactions.run(tx=>{const current=repository.get(runId,tx);if(!current||JSON.stringify(current)!==record||context.owner.pluginGraphHash!==graph)return false;const outcome=writers.apply(tx,prepared);return outcome==='stopped'&&captured.coverage==='complete';});
    }catch{return false;}finally{if(timer)clearTimeout(timer);}
  }
  function stop(op:Operation,owned:NonNullable<ReturnType<typeof live.get>>,reason?:string){
    if(owned.stopTask)return owned.stopTask;owned.stopping=true;grants.delete(op.launch.run.runId);
    try{context.transactions.run(tx=>{const current=repository.get(op.launch.run.runId,tx);if(current&&!terminal(current))repository.update(tx,{...current,state:'stopping',attempt:'stop'});});}catch{/* A storage failure still requires stopping the live owned group; it never authorizes Claim release. */}
    const stopReason=reason??'Run ended; managed execution was stopped.';owned.tools?.revoke();const authority=authorities.get(op.launch.run.runId);if(authority){runFiles.close(authority);authorities.delete(op.launch.run.runId);}try{context.transactions.run(tx=>tools.revokeInTransaction(tx,op.launch.run,'run-ended'));}catch{}try{configurations.revoke(op.launch.run.runId);}catch{/* Physical cleanup still proceeds after configuration persistence failure. */}turns.revoke(op.launch.run.runId,stopReason);owned.close?.();

    owned.stopTask=(async()=>{
    let confirmed=false;try{confirmed=owned.process?(await owned.process.stop()).confirmed:!owned.tools;}catch{}
    // A bounded process stop can return unknown while a real Host writer is still pending.
    // Never await that drain without a bound here or publish stopped from abort alone.
    if(confirmed){try{await owned.tools?.drain();const authority=authorities.get(op.launch.run.runId);if(authority){runFiles.close(authority);authorities.delete(op.launch.run.runId);}}catch{confirmed=false;}}
    if(confirmed)confirmed=await participantStopped(op.launch.run.runId);

    await turns.stopped(op.launch.run.runId,confirmed,stopReason);
    owned.outcome={confirmed,...(reason?{reason}:{})};
    try{publish(op,confirmed?'stopped':'unknown',confirmed?(reason?{reason}:{}):{reason:'Managed process group or registered work could not be confirmed stopped; Workspace remains blocked.'});if(confirmed)live.delete(op.launch.run.runId);}catch{/* Revoked ordinary callbacks cannot write. The joined owned teardown retries this outcome in its cleanup scope. */}
    })();return owned.stopTask;
  }
  async function start(op:Operation,owned:NonNullable<ReturnType<typeof live.get>>){
    let phase='process launch';
    const replay=op.recovery?recovery.stage(op):undefined;let settingUp=true;let replayedEntries:NativeHistoryEntry[]|undefined;
    try{
      if((await workspaces.inspectDirectory(op.launch.workspace.id)).status!=='available')throw new AorkError('WORKSPACE_DIRECTORY_CHANGED','Registered directory changed before process launch',409);
      attempting(op,'spawn');
      const held=grants.get(op.launch.run.runId);
      if(!held||held.generation!==op.launch.run.generation||held.hostEpoch!==op.launch.run.hostEpoch)throw new AorkError('RUN_LAUNCH_GRANT_MISSING','The accepted launch environment authorization is missing; start a new Run explicitly',409);
      const environment:Record<string,string>={PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'C.UTF-8'};
      let environmentNames:string[]|undefined;
      const spawned:{process?:ManagedProcess}={};
      // The grant is consumed synchronously at the last moment before the spawn;
      // assembled values and any credential live only inside this callback scope.
      currentLaunchEnvironment().consume(held.grant,providerEnvironment=>{
        for(const[name,value]of Object.entries(providerEnvironment))environment[name]=value;
        environmentNames=[...Object.keys(environment).sort(),...(process.platform==='darwin'?['__CF_USER_TEXT_ENCODING']:[])].sort();
        spawned.process=runner.spawn(context.owner,{executable:op.launch.agent.launch.executable,arguments:op.launch.agent.launch.arguments,cwd:op.launch.workspace.directory,environment},{changed(state){context.transactions.run(tx=>{const current=repository.get(op.launch.run.runId,tx);if(!current?.writers)throw new AorkError('RUN_WRITER_COVERAGE_MISSING','Managed work requires durable writer coverage',409);repository.update(tx,{...current,writers:{...current.writers,registeredWork:state}});});}});
      });
      grants.delete(op.launch.run.runId);
      const managed=spawned.process;
      if(!managed)throw new AorkError('RUNNER_SPAWN_FAILED','Agent process could not be started',503);
      owned.process=managed;
      context.transactions.run(tx=>{const current=repository.get(op.launch.run.runId,tx)!;repository.update(tx,{...current,processIdentity:managed.identity});});
      const closeProtocol=(reason:string)=>{turns.revoke(op.launch.run.runId,reason);owned.close?.();return stop(op,owned,reason);};
      const wire=boundedIngress(acp.ndJsonStream(Writable.toWeb(managed.stdin),Readable.toWeb(managed.stdout) as ReadableStream<Uint8Array>,{maxMessageBytes:1024*1024}),reason=>{void closeProtocol(reason).catch(()=>{});},{before:(id,message)=>turns.beforeResponse(op,id,message),written:(id,success)=>turns.responseWritten(op,id,success)});
// Preserve raw schema keys until our strict subset validator runs. The SDK
      // built-in parser can discard unknown constraints before a handler sees them.
      const connection=acp.client().onNotification(acp.methods.client.session.update,({params})=>{if(replay&&settingUp)replay.ingest(params);else{configurations.update(op,params);turns.update(op,params);}}).onRequest(acp.methods.client.session.requestPermission,ctx=>replay&&settingUp?Promise.resolve({outcome:{outcome:'cancelled' as const}}):turns.permission(op,ctx,closeProtocol)).onRequest(acp.methods.client.elicitation.create,(raw:unknown)=>raw,ctx=>replay&&settingUp?Promise.resolve({action:'cancel' as const}):turns.input(op,ctx,closeProtocol)).connect(wire);
      owned.close=()=>connection.close();
      const bounded=async<T>(operation:Promise<T>)=>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([operation,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{connection.close();reject(new AorkError('ACP_TIMEOUT','Agent setup did not finish',409));},5000);})]);}finally{if(timer)clearTimeout(timer);}};
      phase='ACP initialization';attempting(op,'initialize');
      const initialized=await bounded(connection.agent.request(acp.methods.agent.initialize,{protocolVersion:acp.PROTOCOL_VERSION,clientInfo:{name:'aork',version:'0.1.0'},clientCapabilities:{elicitation:{form:{}}}}));
      if(initialized.protocolVersion!==acp.PROTOCOL_VERSION)throw new AorkError('ACP_PROTOCOL_UNSUPPORTED','Agent did not negotiate the supported ACP protocol',409);
      phase='tool bridge setup';
      if(op.launch.toolSnapshot){const authority=authorities.get(op.launch.run.runId);if(!authority)throw new AorkError('WORKSPACE_AUTHORITY_INVALID','Run admission authority is unavailable',409);owned.tools=await tools.openRun(op.launch.toolSnapshot,{registerJob:cancel=>owned.process!.registerJob(cancel),currentScope:()=>{const current=repository.get(op.launch.run.runId);const prompt=repository.prompts().find(prompt=>prompt.runId===op.launch.run.runId&&['attempting','running'].includes(prompt.state));return{ready:!owned.stopping&&!closing&&current?.state==='ready'&&!current.stopRequested,...(prompt?{turnId:prompt.turnId}:{})};},onFailure:()=>{void stop(op,owned,'Tool bridge authorization ended; managed execution was stopped.').catch(()=>{});}},authority);}
      const mcpServers:acp.McpServer[] = owned.tools?.descriptor?[{name:'aork',...owned.tools.descriptor}]:[];
      let native:acp.NewSessionResponse;
      if(op.recovery){
        phase='native Session recovery';const source=repository.get(op.recovery.sourceRunId)!;
        if(initialized.agentCapabilities?.loadSession!==true)throw new AorkError('NATIVE_RECOVERY_UNSUPPORTED','New Agent does not support native Session loading',409);
        if(initialized.agentInfo?.version!==source.launch.run.agentVersion||initialized.agentInfo?.name!==source.launch.run.agentName)throw new AorkError('NATIVE_RECOVERY_VERSION_MISMATCH','New Agent identity or version does not match saved native state',409);
        attempting(op,'session.load');
        const loaded=await bounded(connection.agent.request(acp.methods.agent.session.load,{sessionId:op.recovery.nativeSessionId,cwd:op.launch.workspace.directory,mcpServers}));
        replayedEntries=await replay!.finish();
        native={...loaded,sessionId:op.recovery.nativeSessionId};
      }else{phase='native Session creation';attempting(op,'session.new');native=await bounded(connection.agent.request(acp.methods.agent.session.new,{cwd:op.launch.workspace.directory,mcpServers}));}

      turns.ready(op,connection.agent,native.sessionId,reason=>stop(op,owned,reason));
      configurations.ready(op,connection.agent,native.sessionId,reason=>stop(op,owned,reason));
      const ready=publish(op,'ready',{negotiated:negotiatedInput(initialized.agentCapabilities?.promptCapabilities,native),processIdentity:managed.identity,protocolVersion:initialized.protocolVersion,...(environmentNames?{environment:{inherited:false,names:environmentNames}}:{}),...(initialized.agentInfo?.version!==undefined?{agentVersion:initialized.agentInfo.version}:{}),...(initialized.agentInfo?.name!==undefined?{agentName:initialized.agentInfo.name}:{}),nativeSessionId:native.sessionId,stateReference:op.launch.agent.profile.stateDirectory,loadSession:initialized.agentCapabilities?.loadSession===true},replay&&replayedEntries?tx=>replay.commit(tx,replayedEntries!):undefined);
      if(!ready)throw new AorkError('RUN_STOPPING','Native setup was stopped before readiness',409);settingUp=false;
      // Unexpected connection/leader exit is not process-tree stop proof. The actual owned group is stopped first.
      void Promise.race([connection.closed,managed.exited]).then(async()=>{const current=repository.get(op.launch.run.runId);if(current&&!terminal(current)&&!owned.stopping)await stop(op,owned,'Agent connection or managed process exited; managed execution was stopped.');}).catch(()=>{});
    }catch(error){replay?.abort();const safeReasons:Record<string,string>={NATIVE_RECOVERY_UNSUPPORTED:'New Agent does not support native Session loading; retained history remains readable.',NATIVE_RECOVERY_VERSION_MISMATCH:'New Agent identity or version does not match saved native state; retained history remains readable.',NATIVE_REPLAY_LIMIT:'Native replay exceeded supported display bounds; prior history remains readable.'};await stop(op,owned,isAorkError(error)&&safeReasons[error.code]?safeReasons[error.code]:`${phase} failed or was interrupted; managed execution was stopped.`);}
  }
  function dispatch(){if(closing)return;for(const [id,authority] of authorities)if(!repository.get(id)){runFiles.close(authority);authorities.delete(id);}for(const prompt of repository.prompts())if(prompt.cancelRequested)live.get(prompt.runId)?.tools?.cancelTurn(prompt.turnId);configurations.tick();turns.tick();for(const op of repository.active()){

    if(op.launch.run.hostEpoch!==context.owner.hostEpoch||terminal(op))continue;
    let owned=live.get(op.launch.run.runId);
    if(!owned&&op.state==='pending'&&grants.has(op.launch.run.runId)){
      owned={task:Promise.resolve(),stopping:false};live.set(op.launch.run.runId,owned);
      const target=owned;target.task=start(op,target).catch(()=>{try{publish(op,'unknown',{reason:'Runtime persistence or cleanup failed; Workspace remains blocked.'});}catch{}});
    }
    if(op.stopRequested&&owned&&!owned.stopping){const target=owned;const prior=target.task;target.task=(async()=>{turns.revoke(op.launch.run.runId,'Run ended; managed execution was stopped.');target.close?.();await prior;await stop(op,target);})().catch(()=>{});}
  }}
  async function refreshOwnedWork(op:Operation,owned:NonNullable<ReturnType<typeof live.get>>){
    if(!closing||!owned.process||op.writers?.registeredWork!=='unsettled')return;
    // A live owned handle, not a recorded PID, freshly observes the ended group and
    // every registered completion. Record that fact in this caller's cleanup scope.
    try{if((await owned.process.inspectStopped()).confirmed)context.transactions.run(tx=>{const current=repository.get(op.launch.run.runId,tx);if(current?.writers&&current.launch.run.hostEpoch===op.launch.run.hostEpoch&&current.launch.run.generation===op.launch.run.generation)repository.update(tx,{...current,writers:{...current.writers,registeredWork:'settled'}});});}catch{/* A later owned cleanup caller retries; failure never authorizes release. */}
  }
  async function flushTerminalOutcomes(){
    turns.flushStopped();
    for(const [runId,owned]of live){const op=repository.get(runId);if(op)await refreshOwnedWork(op,owned);}
    for(const [runId,owned] of live){const op=repository.get(runId);if(op&&!terminal(op)&&owned.outcome){const {confirmed,reason}=owned.outcome;/* A stop chain that began live can outlive its scope into disposal; re-derive writer coverage here where the owned cleanup context can still complete the participant check. */const covered=confirmed||op.writers?.participantRequired===false||await participantStopped(runId);publish(op,covered?'stopped':'unknown',covered?(reason?{reason}:{}):{reason:'Managed process group or registered work could not be confirmed stopped; Workspace remains blocked.'});if(covered)live.delete(runId);}}
    for(const op of repository.active())if(op.launch.run.hostEpoch===context.owner.hostEpoch&&!live.has(op.launch.run.runId)){const authority=authorities.get(op.launch.run.runId);if(authority){runFiles.close(authority);authorities.delete(op.launch.run.runId);}const covered=op.writers?.participantRequired===false||await participantStopped(op.launch.run.runId);publish(op,covered?'stopped':'unknown',covered?{}:{reason:'Managed writer completion is unverified; Workspace remains blocked.'});}

  }
  let shutdownTask:Promise<void>|undefined;
  const service:AcpRuntime={recovery:recovery.public,facts:facts.source,turnFacts:turns.facts,permissionFacts:turns.permissions,inputFacts:turns.inputs,inputDiagnosticFacts:turns.diagnostics,versions:Object.freeze({nodeVersion:process.versions.node,acpSdkVersion:'2.7.0',platform:process.platform,osRelease:release()}),environmentNames:Object.freeze(process.platform==='darwin'?['PATH','LANG','__CF_USER_TEXT_ENCODING']:['PATH','LANG']),
    async withAdmission(ids,operation){if(closing||admissionClosed)throw new AorkError('RUN_ADMISSION_CLOSED','Run admission is closed for a Plugin change',409);admissions++;try{return await operation();}finally{admissions--;}},
acceptStart(tx,launch,recoveryToken){runSchema.parse(launch.run);if(launch.run.state!=='starting'||launch.run.hostEpoch!==launch.owner.hostEpoch||launch.run.profileRevision!==launch.agent.profile.revision)throw new AorkError('RUN_CONTEXT_INVALID','Run needs a current starting generation and its captured Profile',409);context.verifyOwner(launch.owner);workspaces.verifyClaim(tx,launch.claim,launch.owner,launch.run.runId,launch.workspace.id);profiles.validateLaunch(launch.agent,tx);const registered=workspaces.requireOpenWorkspace(launch.workspace.id,tx);if(registered.directory!==launch.workspace.directory||launch.run.directory!==registered.directory||launch.run.pluginGraphHash!==context.owner.pluginGraphHash)throw new AorkError('RUN_CONTEXT_INVALID','Run launch no longer matches its current Workspace and Host graph',409);if(launch.owner.serviceOwners['aork.sessions@1']?.pluginId!==launch.owner.pluginId)throw new AorkError('RUN_OWNER_INVALID','Only the selected Session lifecycle owner can admit a Run',409);if(closing||admissionClosed||!admissions||launch.run.hostEpoch!==context.owner.hostEpoch)throw new AorkError('RUN_ADMISSION_CLOSED','Run admission is closed',409);if(launch.toolSnapshot)tools.assertCaptured(tx,launch.toolSnapshot);
      const authority=runFiles.bindRunAuthority(tx,launch.claim,launch.owner,launch.run,launch.workspace.id);authorities.set(launch.run.runId,authority);
      const {claim:_permit,...snapshot}=launch;const selectedWriter=context.owner.serviceOwners[EXECUTION_WRITERS];const participant=selectedWriter?executionWriterSnapshotSchema.parse(context.service<ExecutionWriters>(EXECUTION_WRITERS).capture(tx,launch.run)):undefined;if(participant&&!launch.run.usedPluginIds.includes(participant.owner.pluginId))throw new AorkError('RUN_WRITER_GRAPH_INVALID','Run must capture its selected writer participant',409);if(participant&&(participant.owner.pluginId!==selectedWriter?.pluginId||participant.owner.version!==selectedWriter.version))throw new AorkError('RUN_WRITER_OWNER_INVALID','Writer coverage must belong to the selected participant',409);const grant=currentLaunchEnvironment().bind(launch.agent,{runId:launch.run.runId,generation:launch.run.generation,hostEpoch:launch.run.hostEpoch});grants.set(launch.run.runId,{grant,generation:launch.run.generation,hostEpoch:launch.run.hostEpoch});repository.insert(tx,{...(recoveryToken?{recovery:recovery.accept(tx,launch,recoveryToken)}:{}),launch:snapshot,state:'pending',stopRequested:false,writers:{version:1,policy:'posix-group',runner:{...context.owner.serviceOwners[RUNNER_SERVICE]!},registeredWork:'none',participantRequired:Boolean(selectedWriter||context.owner.serviceOwners['aork.tools@1']),...(participant?{participant}:{})}});},
    acceptPrompt:(tx,owner,input)=>turns.accept(tx,owner,input),
    acceptCancel:(tx,owner,turnId)=>turns.cancel(tx,owner,turnId),
    acceptConfiguration:(tx,owner,input)=>configurations.accept(tx,owner,input),
    acceptResponse:(tx,owner,principal,interaction,optionId)=>turns.response(tx,owner,principal,interaction,optionId),
    acceptInputResponse:(tx,owner,principal,interaction,submission)=>turns.inputResponse(tx,owner,principal,interaction,submission),
    acceptStop(tx,owner,runId,generation){context.verifyOwner(owner);const op=repository.get(runId,tx);if(!op||op.launch.owner.pluginId!==owner.pluginId||op.launch.run.generation!==generation)throw new AorkError('RUN_UNAVAILABLE','Run is unavailable',404);if(op.launch.run.hostEpoch!==context.owner.hostEpoch||op.state==='unknown')throw new AorkError('RUN_OWNERSHIP_UNKNOWN','This Run has no live owned process handle; use local maintenance',409);if(op.state==='stopped')return;tools.revokeInTransaction(tx,op.launch.run,'user-ended');repository.update(tx,{...op,stopRequested:true,state:op.state==='pending'?'pending':'stopping'});},

    shutdown(){
if(!shutdownTask){closing=true;shutdownTask=(async()=>{clearInterval(timer);grants.clear();for(const [runId,owned] of live){try{configurations.revoke(runId);}catch{/* Physical cleanup must proceed even when configuration persistence fails. */}turns.revoke(runId,'Host shutdown stopped managed execution.');owned.close?.();/* Start the stop inside this owned cleanup before close-driven watcher microtasks can win the race outside a live scope. */try{const op=repository.get(runId);if(op&&!terminal(op))void stop(op,owned,'Host shutdown stopped managed execution.').catch(()=>{});}catch{/* A storage failure still requires the live owned group stop below. */}}await Promise.all([...live.entries()].map(async([runId,owned])=>{await owned.task;if(owned.stopTask)await owned.stopTask.catch(()=>{});const op=repository.get(runId);if(op&&!terminal(op))await stop(op,owned,'Host shutdown stopped managed execution.');}));const drains=await Promise.allSettled([...live.values()].map(owned=>owned.tools?.drain()));await configurations.drain();await turns.drain();const failed=drains.find(result=>result.status==='rejected');if(failed?.status==='rejected')throw failed.reason;})();}
      // Each caller attaches its own flush, rather than caching the first
      // caller's cleanup authority together with the physical stop task.
      return shutdownTask.then(async()=>{try{await flushTerminalOutcomes();}catch(error){if(!isAorkError(error)||error.code!=='PLUGIN_STOPPED')throw error;}});
    },
  };
  context.lifecycleGuard({acquireChange(affected){admissionClosed++;const relevant=repository.list().filter(op=>!terminal(op)||op.state==='unknown').filter(op=>op.launch.run.usedPluginIds.some(id=>affected.includes(id)));return{state:relevant.some(op=>op.state==='unknown')?'unknown':admissions||relevant.length?'busy':'idle',release(){admissionClosed--;}};}});
  provideReconciliation(context,repository,()=>context.service<RecordedProcessInspection>(RUNNER_INSPECTION),runId=>live.get(runId)?.process);
  context.provideScoped<AcpRuntime>(ACP_RUNTIME,consumer=>({...service,recovery:{historyFacts:recovery.public.historyFacts,prepareRecovery(sourceRunId,principal,agent){selectedSessions(consumer,consumer);return recovery.public.prepareRecovery(sourceRunId,principal,agent);}},
    withAdmission(ids,operation){selectedSessions(consumer,consumer);return service.withAdmission(ids,operation);},
    acceptStart(tx,launch,token){selectedSessions(consumer,launch.owner);service.acceptStart(tx,launch,token);},
    acceptStop(tx,owner,id,generation){selectedSessions(consumer,owner);service.acceptStop(tx,owner,id,generation);},
    acceptPrompt(tx,owner,input){selectedSessions(consumer,owner);service.acceptPrompt(tx,owner,input);},
    acceptCancel(tx,owner,id){selectedSessions(consumer,owner);service.acceptCancel(tx,owner,id);},
    acceptConfiguration(tx,owner,input){selectedSessions(consumer,owner);return service.acceptConfiguration(tx,owner,input);},
    acceptResponse(tx,owner,principal,interaction,option){selectedInteractions(consumer,owner);service.acceptResponse(tx,owner,principal,interaction,option);},
    acceptInputResponse(tx,owner,principal,interaction,submission){selectedInteractions(consumer,owner);service.acceptInputResponse!(tx,owner,principal,interaction,submission);},
  }));

  const timer=setInterval(dispatch,20);context.effect(()=>async()=>{try{await service.shutdown();}finally{await flushTerminalOutcomes();}});
}
