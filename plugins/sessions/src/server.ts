import {nativeHistoryChangedSchema,nativeHistoryQuerySchema,nativeHistoryPageSchema,recoverNativeSchema} from '@aork/contracts/recovery';
import { z } from 'zod';
import { RUNTIME_RECONCILIATION, EXECUTION_WRITERS, SESSION_RECONCILIATION, recheckRunSchema, reconciliationSchema, type Reconciliation, type ReconciliationPreparation, type RuntimeReconciliation } from '@aork/contracts/reconciliation';
import { ACP_RUNTIME, runSchema,publicRun,publicRunSchema } from '@aork/contracts/runtime';
import type { AcpRuntime, RuntimeRun } from '@aork/contracts/runtime';
import { randomUUID } from 'node:crypto';
import { AorkError, isAorkError } from '@aork/sdk';
import type { ServerPluginContext, ReadSnapshot, SyncTransaction, RequestContext } from '@aork/sdk/server';
import { WORKSPACE_SERVICE } from '@aork/contracts/workspace';
import type { WorkspaceService } from '@aork/contracts/workspace';
import { AGENT_PROFILES_SERVICE, AGENT_PROVIDER_REGISTRY } from '@aork/contracts/agent';
import type { AgentProfilesService, AgentProviderRegistry } from '@aork/contracts/agent';
import { sessionReferencesSchema, completedReplyFactSchema, SESSIONS_SERVICE, archiveSessionSchema, createSessionSchema, sessionEntrySchema, sessionSchema, sessionsOverviewSchema, sessionsProjectionSchema, sessionEnvironmentsSchema, turnSchema, sendTextSchema, cancelTurnSchema, timelineMessageSchema, toolDisplaySchema, removeQueuedTurnSchema, continueQueueSchema, queueStateSchema, SESSION_TURN_DETAIL, turnDetailSchema } from '@aork/contracts/session';
import type { Turn } from '@aork/contracts/session';
import type { Session } from '@aork/contracts/session';
import type { SessionsService } from '@aork/contracts/session';
import { sessionRepository } from './persistence/repository.js';
import { boundedTimeline } from './timeline.js';
import { captureInput } from './input.js';
import { configureRunSchema } from '@aork/contracts/input';
export { persistence } from './persistence/repository.js';

export async function activate(context: ServerPluginContext) {
  const repository = sessionRepository(context.repository);
  let runtime:AcpRuntime|undefined;try{runtime=context.service<AcpRuntime>(ACP_RUNTIME);}catch(error){if(!isAorkError(error)||error.code!=='SERVICE_UNAVAILABLE')throw error;}
  const requireRuntime=()=>{if(!runtime)throw new AorkError('RUNTIME_UNAVAILABLE','ACP Runtime is disabled; history remains readable and existing Claims remain protected',409);return runtime;};
  const workspaces = context.service<WorkspaceService>(WORKSPACE_SERVICE);
  const profiles = context.service<AgentProfilesService>(AGENT_PROFILES_SERVICE);
  const providers = context.service<AgentProviderRegistry>(AGENT_PROVIDER_REGISTRY);
  const participants = new Map<string, Parameters<SessionsService['registerArchiveParticipant']>[0] | undefined>();
  const replyStream=context.factStream('completedReplies',completedReplyFactSchema);
  const service: SessionsService = {
    replyFacts:replyStream.source,
    requireSource(principal,source,tx){const row=repository.get(source.sessionId,tx);const turn=repository.turn(source.turnId,tx);if(!row||row.principal!==principal||!turn||turn.sessionId!==source.sessionId||turn.state==='removed')throw new AorkError('SESSION_SOURCE_UNAVAILABLE','Choose an owned Session and an existing, non-removed Turn',404);return{sessionId:source.sessionId,turnId:source.turnId,projectId:row.session.projectId,workspaceId:row.session.workspaceId};},
    getSession: (id, tx) => repository.get(id, tx)?.session,
    requireOpenSession(id, tx) {
      const session = repository.get(id, tx)?.session;
      if (!session || session.status !== 'open') throw new AorkError('SESSION_UNAVAILABLE', 'Session is archived or unavailable', 409);
      workspaces.requireOpenWorkspace(session.workspaceId, tx);
      return session;
    },
    registerArchiveParticipant(participant) {
      if (!/^[a-z][a-z0-9.-]*$/.test(participant.id) || participants.get(participant.id)) throw new AorkError('SESSION_ARCHIVE_POLICY_CONFLICT', 'Archive policy requires a unique stable ID', 409);
      participants.set(participant.id, participant);
      return () => { if (participants.get(participant.id) === participant) participants.set(participant.id, undefined); };
    },
  };
  context.provide(SESSIONS_SERVICE, service);
  const activeTurn=(turn:Turn)=>['dispatching','running','cancelling'].includes(turn.state);
  const queuedTurn=(turn:Turn)=>turn.state==='queued'||turn.state==='accepted';
  const turnEvents={'sessions.queueChanged':{version:1,payload:queueStateSchema},'sessions.turnChanged':{version:1,payload:turnSchema},'sessions.messageAdded':{version:1,payload:timelineMessageSchema},'sessions.toolChanged':{version:1,payload:toolDisplaySchema}};
  if(runtime)context.consumeFacts(runtime.turnFacts,{id:'turnProjection',events:turnEvents,apply(fact,tx){
    const turn=repository.turn(fact.payload.turnId,tx);if(!turn)return{principal:'',events:[]};const row=repository.get(turn.sessionId,tx);const run=repository.run(turn.runId,tx);if(!row||!run||run.generation!==fact.payload.generation||run.hostEpoch!==fact.payload.hostEpoch||!activeTurn(turn))return{principal:row?.principal??'',events:[]};
    const value=fact.payload;if(value.kind==='state'&&(value.dispatchPaused||['cancelled','failed','interrupted','delivery_unknown'].includes(value.state))){repository.pause(tx,turn.sessionId);context.publishEvents(tx,row.principal,[{type:'sessions.queueChanged',version:1,entityId:turn.sessionId,payload:{sessionId:turn.sessionId,dispatchPaused:true}}],turnEvents);}
    if(value.kind==='text'){const message={id:`${turn.id}:${value.sequence}`,turnId:turn.id,role:'agent' as const,sequence:value.sequence,text:value.text,...(value.messageId?{messageId:value.messageId}:{})};repository.insertMessage(tx,turn.sessionId,message);return{principal:row.principal,events:[{type:'sessions.messageAdded',version:1,entityId:turn.id,payload:message}]};}
    if(value.kind==='tool'){repository.putTool(tx,turn.sessionId,value.tool);return{principal:row.principal,events:[{type:'sessions.toolChanged',version:1,entityId:turn.id,payload:value.tool}]};}
    const updated=turnSchema.parse(value.kind==='usage'?{...turn,usage:value.usage}:{...turn,...(value.state==='running'?{hasAgentProgress:true}:{}),...(value.stopReason?{stopReason:value.stopReason}:{}),...(value.reason?{reason:value.reason}:{}),state:turn.state==='cancelling'&&['dispatching','running'].includes(value.state)?'cancelling':value.state});repository.updateTurn(tx,updated);
    if(value.kind==='state'&&updated.state==='completed'){
      const count=repository.agentMessageCount(turn.sessionId,turn.id,tx);
      if(count){repository.insertReply(tx,turn.sessionId,turn.id,count);replyStream.append(tx,turn.id,{principal:row.principal,activityId:turn.id,sessionId:turn.sessionId,turnId:turn.id,projectId:row.session.projectId,workspaceId:row.session.workspaceId,sessionName:row.session.name,source:'live-completion'});}
    }
    return{principal:row.principal,events:[{type:'sessions.turnChanged',version:1,entityId:turn.id,payload:updated}]};
  }});
  const runEvents={...turnEvents,'sessions.runChanged':{version:1,payload:publicRunSchema}};
  context.durableCommand('sessions.configureRun',{
    version:1,payload:configureRunSchema,result:publicRunSchema,events:runEvents,
    execute(payload,_prepared,tx,request){const run=repository.run(payload.runId,tx);if(!run)throw new AorkError('RUN_UNAVAILABLE','Run is unavailable',404);const session=requireOwnedSession(run.sessionId,request.identity,tx);service.requireOpenSession(session.id,tx);if(repository.turns(tx).some(turn=>turn.runId===run.runId&&activeTurn(turn)))throw new AorkError('RUN_CONFIGURATION_BUSY','Wait for the current Turn before changing configuration',409);const configuration=requireRuntime().acceptConfiguration(tx,context.owner,{...payload,id:randomUUID()});const updated={...run,configuration};repository.updateRun(tx,updated);return{result:publicRun(updated),events:[{type:'sessions.runChanged',version:1,entityId:run.runId,payload:publicRun(updated)}]};},
  });
  if(runtime)context.consumeFacts(runtime.facts,{id:'runProjection',events:runEvents,apply(fact,tx){
    const run=repository.run(fact.entityId,tx);if(!run)return{principal:'',events:[]};
    const row=repository.get(run.sessionId,tx);if(!row)return{principal:'',events:[]};
    if((run.state==='stopping'&&fact.payload.state==='ready')||fact.payload.generation!==run.generation||fact.payload.hostEpoch!==run.hostEpoch||run.state==='stopped'||run.state==='unknown')return{principal:row.principal,events:[]};
    const details={...fact.payload.details};
    // A command writes accepted configuration synchronously. Older Runtime facts
    // may still be awaiting this projection and cannot rewind that owner state.
    if(details.configuration&&(details.configuration.sequence??0)<(run.configuration?.sequence??0))delete details.configuration;
    if(details.negotiated&&run.negotiated&&details.negotiated.revision<run.negotiated.revision)delete details.negotiated;
    const updated=runSchema.parse({...run,...details,state:fact.payload.state});repository.updateRun(tx,updated);
    if(['stopped','unknown'].includes(updated.state)&&repository.turns(tx).some(turn=>turn.sessionId===run.sessionId&&(activeTurn(turn)||queuedTurn(turn)))){repository.pause(tx,run.sessionId);context.publishEvents(tx,row.principal,[{type:'sessions.queueChanged',version:1,entityId:run.sessionId,payload:{sessionId:run.sessionId,dispatchPaused:true}}],turnEvents);}
    if(updated.state==='stopped')workspaces.releaseClaim(tx,context.owner,run.runId);
    else if(updated.state==='unknown')workspaces.blockClaim(tx,context.owner,run.runId,updated.reason??'Execution stop is unverified');
    return{principal:row.principal,events:[{type:'sessions.runChanged',version:1,entityId:run.runId,payload:publicRun(updated)}]};
  }});
  context.transactions.run(tx=>{for(const run of repository.runs(tx))if(run.state!=='stopped'&&run.state!=='unknown'&&run.hostEpoch!==context.owner.hostEpoch){const updated={...run,...(run.configuration&&['accepted','dispatching'].includes(run.configuration.state)?{configuration:{...run.configuration,state:run.configuration.state==='accepted'?'failed' as const:'delivery_unknown' as const,reason:'Host restarted before a definitive configuration result; no configuration is automatically resent.'}}:{}),state:'unknown' as const,reason:'Previous Host execution cannot be verified. No operation is automatically resent.'};repository.updateRun(tx,updated);workspaces.blockClaim(tx,context.owner,run.runId,updated.reason);const row=repository.get(run.sessionId,tx);if(row)context.publishEvents(tx,row.principal,[{type:'sessions.runChanged',version:1,entityId:run.runId,payload:publicRun(updated)}],runEvents);}});
  const requireOwnedSession=(id:string,identity:string|undefined,tx?:import('@aork/sdk/server').SyncTransaction)=>{const row=repository.get(id,tx);if(!row||row.principal!==identity)throw new AorkError('SESSION_UNAVAILABLE','Session is unavailable',404);if(row.session.status!=='open')throw new AorkError('SESSION_UNAVAILABLE','Session is archived',409);return row.session;};
  function registerStart(name:string,recover:boolean){context.durableCommand(name,{
    version:1,payload:recoverNativeSchema,result:publicRunSchema,events:runEvents,
    admit(payload,request,commit){const session=requireOwnedSession(payload.sessionId,request.identity);return requireRuntime().withAdmission([],()=>workspaces.withWritePermission(session.workspaceId,()=>commit()));},
    async prepare(payload,request){const session=requireOwnedSession(payload.sessionId,request.identity);const agent=await profiles.prepareLaunch(session.profile);if((await workspaces.inspectDirectory(session.workspaceId)).status!=='available')throw new AorkError('WORKSPACE_DIRECTORY_CHANGED','Registered directory changed during Run preparation',409);const source=repository.runs().filter(run=>run.sessionId===session.id&&(run.nativeBound||run.nativeSessionId)).at(-1);
      if(recover){if(repository.runs().some(run=>run.sessionId===session.id&&run.state!=='stopped'))throw new AorkError('SESSION_RUN_ACTIVE','Old managed writers must be confirmed stopped before native recovery',409);if(!source||!runtime?.recovery)throw new AorkError('NATIVE_RECOVERY_UNAVAILABLE','Native recovery is unavailable; saved history remains readable',409);return{agent,recovery:await runtime.recovery.prepareRecovery(source.runId,request.identity!,agent)};}return{agent};},
    execute(payload,prepared,tx,request){const {agent}=prepared;
      const session=requireOwnedSession(payload.sessionId,request.identity,tx);service.requireOpenSession(session.id,tx);profiles.validateLaunch(agent,tx);
      if(agent.profile.revision!==session.profile.revision)throw new AorkError('PROFILE_REVISION_CHANGED','Saved Session Profile changed; create a new Session explicitly',409);
      const prior=repository.runs(tx).filter(run=>run.sessionId===session.id);if(prior.some(run=>run.state!=='stopped'))throw new AorkError('SESSION_RUN_ACTIVE','End the current Run before starting another',409);
      const workspace=workspaces.requireOpenWorkspace(session.workspaceId,tx);
      const usedPluginIds=[...new Set([context.pluginId,...(context.owner.serviceOwners[EXECUTION_WRITERS]?[context.owner.serviceOwners[EXECUTION_WRITERS]!.pluginId]:[]),...(context.owner.serviceOwners['aork.interactions@1']?[context.owner.serviceOwners['aork.interactions@1']!.pluginId]:[]),agent.providerOwner.pluginId,...['aork.workspace@1','aork.agent.profiles@1','aork.agent.providers@1','aork.runtime.acp@1','aork.runner.local@1'].map(id=>context.owner.serviceOwners[id]!.pluginId)])];
      const run:RuntimeRun=runSchema.parse({runId:randomUUID(),sessionId:session.id,generation:prior.length+1,hostEpoch:context.owner.hostEpoch,state:'starting',directory:workspace.directory,profileRevision:agent.profile.revision,providerDefinitionVersion:agent.providerDefinitionVersion,detectedVersion:agent.detectedVersion,runtime:requireRuntime().versions,environment:{inherited:false,names:requireRuntime().environmentNames},pluginGraphHash:context.owner.pluginGraphHash,usedPluginIds});
      const claim=workspaces.reserveClaim(tx,context.owner,run.runId,workspace.id,usedPluginIds);repository.insertRun(tx,run);requireRuntime().acceptStart(tx,{run,claim,principal:request.identity!,owner:context.owner,workspace,agent},prepared.recovery);
      return{result:publicRun(run),events:[{type:'sessions.runChanged',version:1,entityId:run.runId,payload:publicRun(run)}]};
    },
  });}
  registerStart('sessions.startRun',false);registerStart('sessions.recoverNative',true);
  const nativeEvents={'sessions.nativeHistoryChanged':{version:1,payload:nativeHistoryChangedSchema}};
  if(runtime?.recovery)context.consumeFacts(runtime.recovery.historyFacts,{id:'nativeHistoryProjection',events:nativeEvents,apply(fact,tx){const value=fact.payload;const run=repository.run(value.generation,tx);const row=run&&repository.get(value.sessionId,tx);if(!run||!row||run.sessionId!==value.sessionId)return{principal:row?.principal??'',events:[]};if(value.kind==='entry'){repository.insertNative(tx,value.generation,value.sequence,value.entry);return{principal:row.principal,events:[]};}const active=repository.nativeActive(value.sessionId,tx);const prior=active&&repository.run(active.generation,tx);if(prior&&prior.generation>run.generation)return{principal:row.principal,events:[]};repository.activateNative(tx,value.sessionId,value.generation,value.sourceRunId);const {kind:_kind,count:_count,...changed}=value;return{principal:row.principal,events:[{type:'sessions.nativeHistoryChanged',version:1,entityId:value.sessionId,payload:changed}]};}});
  function readNativeHistory(parameters:Readonly<Record<string,string>>,request:RequestContext,tx?:ReadSnapshot|SyncTransaction){
    const parsed=nativeHistoryQuerySchema.safeParse(parameters);if(!parsed.success)throw new AorkError('NATIVE_HISTORY_QUERY_INVALID','Choose a valid Session and history page',400);const {sessionId,after,generation}=parsed.data;const row=repository.get(sessionId,tx);if(!row||row.principal!==request.identity)throw new AorkError('SESSION_UNAVAILABLE','Session is unavailable',404);
    const active=repository.nativeActive(sessionId,tx);if(generation&&generation!==active?.generation)throw new AorkError('NATIVE_HISTORY_CHANGED','History changed; reload its first page',409);const entries=[];let bytes=512;if(active)for(const entry of repository.nativeEntries(active.generation,after,tx)){const size=Buffer.byteLength(JSON.stringify(entry));if(bytes+size>50*1024)break;entries.push(entry);bytes+=size;}return nativeHistoryPageSchema.parse({sessionId,generation:active?.generation??null,sourceRunId:active?.sourceRunId??null,entries,next:active&&entries.length&&repository.nativeEntries(active.generation,after+entries.length,tx).length?after+entries.length:null});
  }
  context.snapshot('sessions.nativeHistory',{maxBytes:64*1024,read:readNativeHistory});
  context.resource('sessions.nativeHistory',{maxBytes:64*1024,read(parameters,request){return{bytes:Buffer.from(JSON.stringify(readNativeHistory(parameters,request))),mediaType:'application/json'};}});
  context.durableCommand('sessions.endRun',{
    version:1,payload:z.object({runId:z.uuid()}).strict(),result:publicRunSchema,events:{...runEvents,...turnEvents},
    execute(payload,_prepared,tx,request){const run=repository.run(payload.runId,tx);if(!run)throw new AorkError('RUN_UNAVAILABLE','Run is unavailable',404);requireOwnedSession(run.sessionId,request.identity,tx);
      if(run.state==='stopped')return{result:publicRun(run),events:[]};if(run.state==='unknown')throw new AorkError('RUN_OWNERSHIP_UNKNOWN','This Run has no live owned process handle; Workspace remains blocked. Use local maintenance.',409);
      requireRuntime().acceptStop(tx,context.owner,run.runId,run.generation);repository.pause(tx,run.sessionId);const updated={...run,state:'stopping' as const};repository.updateRun(tx,updated);return{result:publicRun(updated),events:[{type:'sessions.queueChanged',version:1,entityId:run.sessionId,payload:{sessionId:run.sessionId,dispatchPaused:true}},{type:'sessions.runChanged',version:1,entityId:run.runId,payload:publicRun(updated)}]};
    },
  });
  context.transactions.run(tx=>{for(const turn of repository.turns(tx))if(activeTurn(turn)||queuedTurn(turn)){const run=repository.run(turn.runId,tx);if(!run||run.hostEpoch!==context.owner.hostEpoch){const row=repository.get(turn.sessionId,tx);if(!row)continue;if(!repository.paused(turn.sessionId,tx)){repository.pause(tx,turn.sessionId);context.publishEvents(tx,row.principal,[{type:'sessions.queueChanged',version:1,entityId:turn.sessionId,payload:{sessionId:turn.sessionId,dispatchPaused:true}}],turnEvents);}if(activeTurn(turn)){const updated={...turn,state:turn.hasAgentProgress||turn.state==='running'?'interrupted' as const:'delivery_unknown' as const,reason:'Host restarted; dispatch is paused and no input is automatically resent.'};repository.updateTurn(tx,updated);context.publishEvents(tx,row.principal,[{type:'sessions.turnChanged',version:1,entityId:turn.id,payload:updated}],turnEvents);}}}});
  const reconciliationEvents = { ...runEvents, 'sessions.reconciliationChanged': { version: 1, payload: reconciliationSchema } };
  type PreparedCheck = { run: RuntimeRun; principal: string; service?: RuntimeReconciliation; token?: ReconciliationPreparation; diagnostic?: Reconciliation };
  async function prepareCheck(run: RuntimeRun, principal: string): Promise<PreparedCheck> {
    if (run.state === 'stopped') return {run,principal,diagnostic:reconciliationSchema.parse({runId:run.runId,generation:run.generation,status:'verified-stopped',reason:'managed-stop-confirmed',observedAt:new Date().toISOString(),coverage:repository.reconciliation(run.runId)?.coverage??'unknown',actions:[]})};
    let reconciler: RuntimeReconciliation;
    try { reconciler = context.service<RuntimeReconciliation>(RUNTIME_RECONCILIATION); }
    catch (error) {
      if (!isAorkError(error) || error.code !== 'SERVICE_UNAVAILABLE') throw error;
      return { run, principal, diagnostic: reconciliationSchema.parse({runId:run.runId,generation:run.generation,status:'blocked',reason:'authority-unavailable',observedAt:new Date().toISOString(),coverage:'unknown',actions:['check-again','restore-authority']}) };
    }
    return {run,principal,service:reconciler,token:await reconciler.prepare(run.runId,principal)};
  }
  function applyCheck(tx: SyncTransaction, prepared: PreparedCheck) {
    const run = repository.run(prepared.run.runId, tx); const row = run && repository.get(run.sessionId, tx);
    if (!run || !row || row.principal !== prepared.principal || JSON.stringify(run) !== JSON.stringify(prepared.run)) throw new AorkError('RECONCILIATION_PREPARATION_STALE','Run changed during the check; request a fresh check',409);
    const diagnostic = prepared.service && prepared.token ? prepared.service.apply(tx,prepared.token) : prepared.diagnostic!;
    if (diagnostic.generation !== run.generation) throw new AorkError('RECONCILIATION_PREPARATION_STALE','Run generation changed during the check',409);
    const current=repository.runs(tx).filter(value=>value.sessionId===run.sessionId).at(-1);
    const affectsCurrent=current?.runId===run.runId&&current.generation===run.generation;
    repository.putReconciliation(tx,diagnostic);
    const events: import('@aork/sdk/server').BrowserEventDraft[] = [
      {type:'sessions.reconciliationChanged',version:1,entityId:run.runId,payload:diagnostic},
    ];
    if(affectsCurrent){repository.pause(tx,run.sessionId);events.push({type:'sessions.queueChanged',version:1,entityId:run.sessionId,payload:{sessionId:run.sessionId,dispatchPaused:true}});}
    if (diagnostic.status === 'verified-stopped') {
      workspaces.releaseClaim(tx,context.owner,run.runId);
      if (run.state !== 'stopped') { const updated=runSchema.parse({...run,state:'stopped',reason:'Managed writers were verified stopped. Queued inputs remain paused.'}); repository.updateRun(tx,updated); events.push({type:'sessions.runChanged',version:1,entityId:run.runId,payload:publicRun(updated)}); }
    } else workspaces.blockClaim(tx,context.owner,run.runId,'Managed writer stop is unverified; inspect locally and check again.');
    return {result:diagnostic,events};
  }
  // Activation is awaited by the Host. External observations finish before the
  // queue timer exists and before HTTP admission opens; no old ACP is adopted.
  for (const run of repository.runs().filter(run=>run.state==='unknown')) {
    const row=repository.get(run.sessionId); if (!row) continue;
    const prepared=await prepareCheck(run,row.principal);
    context.transactions.run(tx=>{const result=applyCheck(tx,prepared);context.publishEvents(tx,row.principal,result.events,reconciliationEvents);});
  }
  context.durableCommand('sessions.recheckRun',{
    version:1,payload:recheckRunSchema,result:reconciliationSchema,events:reconciliationEvents,
    async prepare(payload,request){const run=repository.run(payload.runId);if(!run)throw new AorkError('RUN_UNAVAILABLE','Run is unavailable',404);requireOwnedSession(run.sessionId,request.identity);return prepareCheck(run,request.identity!);},
    execute(payload,prepared,tx,request){const run=repository.run(payload.runId,tx);if(!run)throw new AorkError('RUN_UNAVAILABLE','Run is unavailable',404);requireOwnedSession(run.sessionId,request.identity,tx);return applyCheck(tx,prepared);},
  });
  function readReconciliation(parameters:Readonly<Record<string,string>>,request:RequestContext,tx?:ReadSnapshot|SyncTransaction) {
    const parsed=recheckRunSchema.safeParse(parameters);if(!parsed.success)throw new AorkError('RUN_QUERY_INVALID','Choose a valid Run ID',400);
    const run=repository.run(parsed.data.runId,tx);const row=run&&repository.get(run.sessionId,tx);if(!run||!row||row.principal!==request.identity)throw new AorkError('RUN_UNAVAILABLE','Run is unavailable',404);
    return {reconciliation:repository.reconciliation(run.runId,tx)??null};
  }
  context.snapshot(SESSION_RECONCILIATION,{maxBytes:4096,read:readReconciliation});
  context.resource(SESSION_RECONCILIATION,{maxBytes:4096,read(parameters,request){return{bytes:Buffer.from(JSON.stringify(readReconciliation(parameters,request))),mediaType:'application/json'};}});
  context.durableCommand('sessions.sendText',{
    version:1,payload:sendTextSchema,result:turnSchema,events:turnEvents,
    async prepare(payload,request){const session=requireOwnedSession(payload.sessionId,request.identity);const run=repository.runs().filter(run=>run.sessionId===session.id).at(-1);if(!run||run.state!=='ready')throw new AorkError('RUN_NOT_READY','Prepare a ready Run before sending input',409);const captured=await captureInput(workspaces,session.workspaceId,payload.text,payload.attachments??[],run.negotiated);return{...captured,runId:run.runId,generation:run.generation,revision:run.negotiated?.revision};},
    execute(payload,prepared,tx,request){
      const session=requireOwnedSession(payload.sessionId,request.identity,tx);service.requireOpenSession(session.id,tx);
      const turns=repository.turns(tx);if(turns.filter(turn=>turn.sessionId===session.id&&queuedTurn(turn)).length>=100)throw new AorkError('SESSION_QUEUE_FULL','Remove queued inputs or wait before adding more',409);
      const run=repository.runs(tx).filter(run=>run.sessionId===session.id).at(-1);if(!run||run.state!=='ready')throw new AorkError('RUN_NOT_READY','Prepare a ready Run before sending text',409);
      if(run.runId!==prepared.runId||run.generation!==prepared.generation||run.negotiated?.revision!==prepared.revision)throw new AorkError('RUN_CONFIGURATION_CHANGED','Run configuration changed while preparing input; retry with current options',409);
      if(run.configuration&&['accepted','dispatching','delivery_unknown'].includes(run.configuration.state))throw new AorkError('RUN_CONFIGURATION_BUSY','Wait for a confirmed Run configuration',409);
      const turn=turnSchema.parse({id:randomUUID(),sessionId:session.id,runId:run.runId,generation:run.generation,configuration:run.negotiated,configurationRun:{runId:run.runId,generation:run.generation},...(prepared.attachments.length?{attachments:prepared.attachments}:{}),state:'queued',acceptanceOrder:(turns.at(-1)?.acceptanceOrder??0)+1,createdAt:new Date().toISOString()});
      repository.insertTurn(tx,turn);repository.insertInput(tx,turn.id,prepared.content);const message={id:`${turn.id}:user`,turnId:turn.id,role:'user' as const,sequence:0,text:payload.text};repository.insertMessage(tx,session.id,message);
      return{result:turn,events:[{type:'sessions.turnChanged',version:1,entityId:turn.id,payload:turn},{type:'sessions.messageAdded',version:1,entityId:turn.id,payload:message}]};
    },
  });
  // Acceptance/receipt and dispatch intent are separate transactions. No ACP I/O occurs here.
  let scheduling=true;
  const dispatchTimer=setInterval(()=>{
    if(!scheduling||!runtime)return;
    // A Session's eligibility or stale authority must not roll back another
    // Session's dispatch. Each reservation still commits with its Runtime intent.
    let sessionIds:Set<string>;try{sessionIds=new Set(repository.turns().filter(queuedTurn).map(turn=>turn.sessionId));}catch{scheduling=false;return;}
    for(const sessionId of sessionIds){
      try{context.transactions.run(tx=>{
        const turns=repository.turns(tx).filter(turn=>turn.sessionId===sessionId);
        if(turns.some(activeTurn)||repository.paused(sessionId,tx))return;
        const turn=turns.find(queuedTurn);if(!turn)return;
        const row=repository.get(sessionId,tx);if(!row||row.session.status!=='open')return;
        service.requireOpenSession(sessionId,tx);
        const run=repository.runs(tx).filter(run=>run.sessionId===sessionId).at(-1);
        if(!run||run.runId!==turn.runId||run.generation!==turn.generation||run.hostEpoch!==context.owner.hostEpoch||run.state!=='ready')return;
        const text=repository.message(`${turn.id}:user`,tx)?.text;if(text===undefined)throw new AorkError('TURN_INPUT_MISSING','Accepted input is unavailable',500);
        const updated={...turn,state:'dispatching' as const};if(!repository.dispatchTurn(tx,updated))return;
        requireRuntime().acceptPrompt(tx,context.owner,{turnId:turn.id,runId:run.runId,generation:run.generation,text,content:repository.input(turn.id,tx)??[{type:'text',text}],configurationRevision:turn.configuration?.revision,configuration:turn.configuration});
        context.publishEvents(tx,row.principal,[{type:'sessions.turnChanged',version:1,entityId:turn.id,payload:updated}],turnEvents);
      });}catch(error){
        if(isAorkError(error)&&error.status===409){
          try{context.transactions.run(tx=>{const row=repository.get(sessionId,tx);if(!row||repository.paused(sessionId,tx))return;repository.pause(tx,sessionId);context.publishEvents(tx,row.principal,[{type:'sessions.queueChanged',version:1,entityId:sessionId,payload:{sessionId,dispatchPaused:true}}],turnEvents);});}
          catch{scheduling=false;break;}
        }else{scheduling=false;break;}
      }
    }
  },20);
  context.effect(()=>()=>{scheduling=false;clearInterval(dispatchTimer);});
  context.durableCommand('sessions.removeQueuedTurn',{
    version:1,payload:removeQueuedTurnSchema,result:turnSchema,events:turnEvents,
    execute(payload,_prepared,tx,request){const turn=repository.turn(payload.turnId,tx);if(!turn)throw new AorkError('TURN_UNAVAILABLE','Turn is unavailable',404);requireOwnedSession(turn.sessionId,request.identity,tx);if(!queuedTurn(turn))throw new AorkError('TURN_ALREADY_DISPATCHED','Only queued input can be removed; it may already have been dispatched',409);const updated={...turn,state:'removed' as const,reason:'User removed input before dispatch. Original input is retained in history.'};repository.updateTurn(tx,updated);return{result:updated,events:[{type:'sessions.turnChanged',version:1,entityId:turn.id,payload:updated}]};},
  });
  context.durableCommand('sessions.continueQueue',{
    version:1,payload:continueQueueSchema,result:queueStateSchema,events:turnEvents,
    execute(payload,_prepared,tx,request){const session=requireOwnedSession(payload.sessionId,request.identity,tx);service.requireOpenSession(session.id,tx);requireRuntime();const run=repository.runs(tx).filter(run=>run.sessionId===session.id).at(-1);if(!run||run.runId!==payload.runId||run.state!=='ready'||run.hostEpoch!==context.owner.hostEpoch)throw new AorkError('RUN_NOT_READY','Continue requires the current ready Run',409);
      const turns=repository.turns(tx).filter(turn=>turn.sessionId===session.id);if(turns.some(activeTurn))throw new AorkError('SESSION_TURN_ACTIVE','Wait for the current prompt to finish before continuing the queue',409);
      const queued=turns.filter(queuedTurn);if(queued.some(turn=>turn.runId!==run.runId||turn.generation!==run.generation)&&!payload.allowNewContext)throw new AorkError('QUEUE_NEW_CONTEXT_CONFIRMATION_REQUIRED','Queued inputs belong to a previous Run. Explicitly choose the new native context before continuing.',409);
      const events:import('@aork/sdk/server').BrowserEventDraft[]=[];for(const turn of queued)if(turn.runId!==run.runId||turn.generation!==run.generation){const updated={...turn,runId:run.runId,generation:run.generation};repository.updateTurn(tx,updated);events.push({type:'sessions.turnChanged',version:1,entityId:turn.id,payload:updated});}
      repository.resume(tx,session.id);const result={sessionId:session.id,dispatchPaused:false,runId:run.runId};return{result,events:[...events,{type:'sessions.queueChanged',version:1,entityId:session.id,payload:result}]};},
  });
  context.durableCommand('sessions.cancelTurn',{
    version:1,payload:cancelTurnSchema,result:turnSchema,events:turnEvents,
    execute(payload,_prepared,tx,request){const turn=repository.turn(payload.turnId,tx);if(!turn)throw new AorkError('TURN_UNAVAILABLE','Turn is unavailable',404);requireOwnedSession(turn.sessionId,request.identity,tx);if(!activeTurn(turn)&&!queuedTurn(turn))return{result:turn,events:[]};repository.pause(tx,turn.sessionId);if(activeTurn(turn))requireRuntime().acceptCancel(tx,context.owner,turn.id);const updated={...turn,state:queuedTurn(turn)?'cancelled' as const:'cancelling' as const};repository.updateTurn(tx,updated);return{result:updated,events:[{type:'sessions.turnChanged',version:1,entityId:turn.id,payload:updated},{type:'sessions.queueChanged',version:1,entityId:turn.sessionId,payload:{sessionId:turn.sessionId,dispatchPaused:true}}]};},
  });
  function referenceName(name:string){
    // Fifty UUID/linkage summaries plus256 serialized UTF-8 bytes per label
    // fit under the existing32768-byte snapshot limit, even for escaped names.
    if(Buffer.byteLength(JSON.stringify(name))<=256)return {name};
    let preview='';let bytes=2;
    for(const point of name){
      const charge=Buffer.byteLength(JSON.stringify(point))-2;
      if(bytes+charge>256)break;
      preview+=point;bytes+=charge;
    }
    return {name:preview,nameTruncated:true as const};
  }
  context.snapshot('sessions.references',{maxBytes:32768,read(parameters,request,tx){
    const ids=parameters.ids?.split(',')??[];if(Object.keys(parameters).some(key=>key!=='ids')||ids.length>50||ids.some(id=>!z.uuid().safeParse(id).success))throw new AorkError('SESSION_QUERY_INVALID','Choose up to fifty Session references',400);
    return sessionReferencesSchema.parse({sessions:ids.flatMap(id=>{const row=repository.get(id,tx);return row&&row.principal===request.identity?[{id:row.session.id,...referenceName(row.session.name),projectId:row.session.projectId,workspaceId:row.session.workspaceId}]:[];})});
  }});
  context.snapshot('sessions.reply',{maxBytes:1024*1024,read(parameters,request,tx){
    const parsed=z.object({turnId:z.uuid(),after:z.string().regex(/^(0|[1-9][0-9]{0,8})$/).default('0')}).strict().safeParse(parameters);if(!parsed.success)throw new AorkError('REPLY_QUERY_INVALID','Choose a valid completed reply page',400);
    const turn=repository.turn(parsed.data.turnId,tx);const row=turn&&repository.get(turn.sessionId,tx);if(!turn||!row||row.principal!==request.identity||!repository.replies(turn.sessionId,tx).some(reply=>reply.id===turn.id))throw new AorkError('REPLY_UNAVAILABLE','Completed reply is unavailable',404);
    const rows=repository.replyMessages(turn.sessionId,turn.id,Number(parsed.data.after),tx);const messages=rows.slice(0,50);while(messages.length>1&&Buffer.byteLength(JSON.stringify(messages))>900000)messages.pop();
    return {activityId:turn.id,sessionId:turn.sessionId,turnId:turn.id,messages,...(rows.length>messages.length?{next:String(messages.at(-1)!.sequence)}:{})};
  }});
  function readTimeline(parameters:Readonly<Record<string,string>>,request:RequestContext,tx?:ReadSnapshot|SyncTransaction){
    const id=z.uuid().safeParse(parameters.sessionId);if(!id.success)throw new AorkError('SESSION_QUERY_INVALID','Choose a Session');const row=repository.get(id.data,tx);if(!row||row.principal!==request.identity)throw new AorkError('SESSION_UNAVAILABLE','Session is unavailable',404);
    const turns=repository.turns(tx).filter(turn=>turn.sessionId===id.data);const recent=repository.messages(id.data,tx);const tools=repository.tools(id.data,tx);const loaded=new Set(recent.map(message=>message.id));
    // A long active stream can push accepted user messages outside the recent
    // chunk window. Keep a preview of every actionable input discoverable.
    const retained=turns.filter(turn=>activeTurn(turn)||queuedTurn(turn)).flatMap(turn=>{const key=`${turn.id}:user`;if(loaded.has(key))return[];const message=repository.message(key,tx);return message?[message]:[];});
    const replies=repository.replies(id.data,tx);
    // At most150 final Turn IDs; reserve their fixed UUID-summary charge while
    // preserving the accepted900k bound for the entire composed public DTO.
    const value=boundedTimeline({sessionId:id.data,completedReplies:[],dispatchPaused:repository.paused(id.data,tx),turns,messages:[...retained,...recent],tools,truncated:recent.length===1000||tools.length===200},Math.min(150,replies.length)*110);
    // Read IDs describe only the final display result, after all accepted input
    // summaries, protected previews and Agent-chunk byte compaction have run.
    const included=new Set(value.turns.map(turn=>turn.id));
    value.completedReplies=replies.filter(reply=>included.has(reply.id)&&value.messages.filter(message=>message.turnId===reply.id&&message.role==='agent'&&!message.truncated).length===reply.message_count).map(reply=>({activityId:reply.id,turnId:reply.id}));
    return value;
  }
  function readTurnDetail(parameters:Readonly<Record<string,string>>,request:RequestContext,tx?:ReadSnapshot|SyncTransaction){
    const parsed=z.object({turnId:z.uuid()}).strict().safeParse(parameters);if(!parsed.success)throw new AorkError('SESSION_QUERY_INVALID','Choose a Turn');const turn=repository.turn(parsed.data.turnId,tx);const row=turn&&repository.get(turn.sessionId,tx);if(!turn||!row||row.principal!==request.identity)throw new AorkError('TURN_UNAVAILABLE','Turn is unavailable',404);
    const input=repository.message(`${turn.id}:user`,tx);if(!input)throw new AorkError('TURN_INPUT_MISSING','Original input is unavailable',500);
    return turnDetailSchema.parse({sessionId:turn.sessionId,turn,input});
  }
  context.resource(SESSION_TURN_DETAIL,{maxBytes:64*1024,read(parameters,request){return{bytes:Buffer.from(JSON.stringify(readTurnDetail(parameters,request))),mediaType:'application/json'};}});
  context.snapshot(SESSION_TURN_DETAIL,{maxBytes:64*1024,read:readTurnDetail});
  context.resource('sessions.timeline',{maxBytes:1024*1024,read(parameters,request){return{bytes:Buffer.from(JSON.stringify(readTimeline(parameters,request))),mediaType:'application/json'};}});
  context.snapshot('sessions.timeline',{maxBytes:1024*1024,read:readTimeline});
  function projection(session:Session,tx?:ReadSnapshot|SyncTransaction){const turns=repository.turns(tx).filter(turn=>turn.sessionId===session.id);const runs=repository.runs(tx).filter(run=>run.sessionId===session.id);return {session,dispatchPaused:repository.paused(session.id,tx),currentTurn:turns.filter(activeTurn).at(-1)??turns.filter(turn=>!queuedTurn(turn)).at(-1),execution:runs.length?publicRun(runs.at(-1)!):{state:'not-started' as const},nativeHistory:{restorable:false as const,reason:!runs.length?'never-started' as const:!runtime?.recovery?'runtime-unavailable' as const:runs.some(run=>run.state!=='stopped')?'execution-active' as const:runs.some(run=>(run.nativeBound||run.nativeSessionId)&&run.loadSession)?'check-required' as const:'load-unsupported' as const}};}
  context.snapshot('sessions.overview',{maxBytes:1024*1024,read(_parameters,request,tx){return sessionsProjectionSchema.parse({sessions:repository.list(request.identity!,tx).map(session=>projection(session,tx))});}});
  async function entry(session: Session) {
    let status = 'open'; try { workspaces.requireOpenWorkspace(session.workspaceId); } catch { status = 'archived-or-unavailable'; }
    return sessionEntrySchema.parse({...projection(session),environment:{status,directory:await workspaces.inspectDirectory(session.workspaceId)}});
  }
  context.query('sessions.environments',{access:'authenticated',async execute(request){return sessionEnvironmentsSchema.parse({environments:await Promise.all(repository.list(request.identity!).map(async session=>{const value=await entry(session);return{sessionId:session.id,environment:value.environment};}))});}});
  context.query('sessions.overview', { access: 'authenticated', async execute(request) {
    return sessionsOverviewSchema.parse({ sessions: await Promise.all(repository.list(request.identity!).map(entry)) });
  } });
  context.resource('sessions.detail', { maxBytes: 1024 * 1024, async read(parameters, request) {
    const input = archiveSessionSchema.safeParse(parameters); if (!input.success) throw new AorkError('SESSION_QUERY_INVALID', 'Choose a valid Session ID');
    const row = repository.get(input.data.id); if (!row || row.principal !== request.identity) throw new AorkError('SESSION_UNAVAILABLE', 'Session is unavailable', 404);
    return { bytes: Buffer.from(JSON.stringify(await entry(row.session))), mediaType: 'application/json' };
  } });
  context.durableCommand('sessions.create', {
    version: 1, payload: createSessionSchema, result: sessionSchema,
    events: { 'sessions.created': { version: 1, payload: sessionSchema } },
    execute(payload, _prepared, transaction, request) {
      const workspace = workspaces.requireOpenWorkspace(payload.workspaceId, transaction);
      if (workspace.projectId !== payload.projectId) throw new AorkError('SESSION_ENVIRONMENT_MISMATCH', 'Workspace does not belong to the selected Project', 409);
      const profile = profiles.snapshot(payload.profileId, transaction);
      const provider = providers.get(profile.providerId);
      if (!provider) throw new AorkError('PROVIDER_UNAVAILABLE', 'Agent Provider is not registered', 409);
      const { stateDirectory: _privateStateDirectory, ...selection } = profile;
      const session = sessionSchema.parse({ ...payload, id: randomUUID(), status: 'open', createdAt: new Date().toISOString(), workspace, profile: selection, providerLabel: provider.label });
      repository.insert(transaction, request.identity!, session);
      return { result: session, events: [{ type: 'sessions.created', version: 1, entityId: session.id, payload: session }] };
    },
  });
  context.durableCommand('sessions.archive', {
    version: 1, payload: archiveSessionSchema, result: sessionSchema,
    events: { 'sessions.archived': { version: 1, payload: sessionSchema } },
    execute(payload, _prepared, transaction, request) {
      const row = repository.get(payload.id, transaction);
      if (!row || row.principal !== request.identity) throw new AorkError('SESSION_UNAVAILABLE', 'Session is unavailable', 404);
      if(repository.runs(transaction).some(run=>run.sessionId===row.session.id&&run.state!=='stopped'))throw new AorkError('SESSION_RUN_ACTIVE','Active or unknown Runs must be resolved before archival',409);
      for (const participant of participants.values()) {
        if (!participant) throw new AorkError('SESSION_ARCHIVE_POLICY_UNAVAILABLE', 'Execution ownership must be verified before archiving', 409);
        const outcome: unknown = participant.assertCanArchive(structuredClone(row.session), transaction);
        if (outcome && typeof outcome === 'object' && 'then' in outcome) {
          void Promise.resolve(outcome).catch(() => {});
          throw new AorkError('SESSION_ARCHIVE_POLICY_INVALID', 'Archive policy must complete synchronously', 409);
        }
      }
      const session = { ...row.session, status: 'archived' as const }; repository.update(transaction, session);
      return { result: session, events: [{ type: 'sessions.archived', version: 1, entityId: session.id, payload: session }] };
    },
  });
}
