import { z } from 'zod';
import { ACP_RUNTIME, runSchema } from '@aork/contracts/runtime';
import type { AcpRuntime, RuntimeRun } from '@aork/contracts/runtime';
import { randomUUID } from 'node:crypto';
import { AorkError, isAorkError } from '@aork/sdk';
import type { ServerPluginContext } from '@aork/sdk/server';
import { WORKSPACE_SERVICE } from '@aork/contracts/workspace';
import type { WorkspaceService } from '@aork/contracts/workspace';
import { AGENT_PROFILES_SERVICE, AGENT_PROVIDER_REGISTRY } from '@aork/contracts/agent';
import type { AgentProfilesService, AgentProviderRegistry } from '@aork/contracts/agent';
import { SESSIONS_SERVICE, archiveSessionSchema, createSessionSchema, sessionEntrySchema, sessionSchema, sessionsOverviewSchema } from '@aork/contracts/session';
import type { Session } from '@aork/contracts/session';
import type { SessionsService } from '@aork/contracts/session';
import { sessionRepository } from './persistence/repository.js';
export { persistence } from './persistence/repository.js';

export function activate(context: ServerPluginContext) {
  const repository = sessionRepository(context.repository);
  let runtime:AcpRuntime|undefined;try{runtime=context.service<AcpRuntime>(ACP_RUNTIME);}catch(error){if(!isAorkError(error)||error.code!=='SERVICE_UNAVAILABLE')throw error;}
  const requireRuntime=()=>{if(!runtime)throw new AorkError('RUNTIME_UNAVAILABLE','ACP Runtime is disabled; history remains readable and existing Claims remain protected',409);return runtime;};
  const workspaces = context.service<WorkspaceService>(WORKSPACE_SERVICE);
  const profiles = context.service<AgentProfilesService>(AGENT_PROFILES_SERVICE);
  const providers = context.service<AgentProviderRegistry>(AGENT_PROVIDER_REGISTRY);
  const participants = new Map<string, Parameters<SessionsService['registerArchiveParticipant']>[0] | undefined>();
  const service: SessionsService = {
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
  const runEvents={'sessions.runChanged':{version:1,payload:runSchema}};
  if(runtime)context.consumeFacts(runtime.facts,{id:'runProjection',events:runEvents,apply(fact,tx){
    const run=repository.run(fact.entityId,tx);if(!run)return{principal:'',events:[]};
    const row=repository.get(run.sessionId,tx);if(!row)return{principal:'',events:[]};
    if((run.state==='stopping'&&fact.payload.state==='ready')||fact.payload.generation!==run.generation||fact.payload.hostEpoch!==run.hostEpoch||run.state==='stopped'||run.state==='unknown')return{principal:row.principal,events:[]};
    const updated=runSchema.parse({...run,...fact.payload.details,state:fact.payload.state});repository.updateRun(tx,updated);
    if(updated.state==='stopped')workspaces.releaseClaim(tx,context.owner,run.runId);
    else if(updated.state==='unknown')workspaces.blockClaim(tx,context.owner,run.runId,updated.reason??'Execution stop is unverified');
    return{principal:row.principal,events:[{type:'sessions.runChanged',version:1,entityId:run.runId,payload:updated}]};
  }});
  context.transactions.run(tx=>{for(const run of repository.runs(tx))if(run.state!=='stopped'&&run.state!=='unknown'&&run.hostEpoch!==context.owner.hostEpoch){const updated={...run,state:'unknown' as const,reason:'Previous Host execution cannot be verified. No operation is automatically resent.'};repository.updateRun(tx,updated);workspaces.blockClaim(tx,context.owner,run.runId,updated.reason);}});
  const requireOwnedSession=(id:string,identity:string|undefined,tx?:import('@aork/sdk/server').SyncTransaction)=>{const row=repository.get(id,tx);if(!row||row.principal!==identity)throw new AorkError('SESSION_UNAVAILABLE','Session is unavailable',404);if(row.session.status!=='open')throw new AorkError('SESSION_UNAVAILABLE','Session is archived',409);return row.session;};
  context.durableCommand('sessions.startRun',{
    version:1,payload:z.object({sessionId:z.uuid()}).strict(),result:runSchema,events:runEvents,
    admit(payload,request,commit){const session=requireOwnedSession(payload.sessionId,request.identity);return requireRuntime().withAdmission([],()=>workspaces.withWritePermission(session.workspaceId,()=>commit()));},
    async prepare(payload,request){const session=requireOwnedSession(payload.sessionId,request.identity);return profiles.prepareLaunch(session.profile);},
    execute(payload,agent,tx,request){
      const session=requireOwnedSession(payload.sessionId,request.identity,tx);service.requireOpenSession(session.id,tx);profiles.validateLaunch(agent,tx);
      if(agent.profile.revision!==session.profile.revision)throw new AorkError('PROFILE_REVISION_CHANGED','Saved Session Profile changed; create a new Session explicitly',409);
      const prior=repository.runs(tx).filter(run=>run.sessionId===session.id);if(prior.some(run=>run.state!=='stopped'))throw new AorkError('SESSION_RUN_ACTIVE','End the current Run before starting another',409);
      const workspace=workspaces.requireOpenWorkspace(session.workspaceId,tx);
      const usedPluginIds=[...new Set([context.pluginId,agent.providerOwner.pluginId,...['aork.workspace@1','aork.agent.profiles@1','aork.agent.providers@1','aork.runtime.acp@1','aork.runner.local@1'].map(id=>context.owner.serviceOwners[id]!.pluginId)])];
      const run:RuntimeRun=runSchema.parse({runId:randomUUID(),sessionId:session.id,generation:prior.length+1,hostEpoch:context.owner.hostEpoch,state:'starting',directory:workspace.directory,profileRevision:agent.profile.revision,providerDefinitionVersion:agent.providerDefinitionVersion,detectedVersion:agent.detectedVersion,runtime:requireRuntime().versions,environment:{inherited:false,names:requireRuntime().environmentNames},pluginGraphHash:context.owner.pluginGraphHash,usedPluginIds});
      workspaces.reserveClaim(tx,context.owner,run.runId,workspace.id,usedPluginIds);repository.insertRun(tx,run);requireRuntime().acceptStart(tx,{run,principal:request.identity!,owner:context.owner,workspace,agent});
      return{result:run,events:[{type:'sessions.runChanged',version:1,entityId:run.runId,payload:run}]};
    },
  });
  context.durableCommand('sessions.endRun',{
    version:1,payload:z.object({runId:z.uuid()}).strict(),result:runSchema,events:runEvents,
    execute(payload,_prepared,tx,request){const run=repository.run(payload.runId,tx);if(!run)throw new AorkError('RUN_UNAVAILABLE','Run is unavailable',404);requireOwnedSession(run.sessionId,request.identity,tx);
      if(run.state==='stopped')return{result:run,events:[]};if(run.state==='unknown')throw new AorkError('RUN_OWNERSHIP_UNKNOWN','This Run has no live owned process handle; Workspace remains blocked. Use local maintenance.',409);
      requireRuntime().acceptStop(tx,context.owner,run.runId,run.generation);const updated={...run,state:'stopping' as const};repository.updateRun(tx,updated);return{result:updated,events:[{type:'sessions.runChanged',version:1,entityId:run.runId,payload:updated}]};
    },
  });
  async function entry(session: Session) {
    let status = 'open'; try { workspaces.requireOpenWorkspace(session.workspaceId); } catch { status = 'archived-or-unavailable'; }
    return sessionEntrySchema.parse({ session, environment: { status, directory: await workspaces.inspectDirectory(session.workspaceId) }, execution: repository.runs().filter(run=>run.sessionId===session.id).at(-1)??{state:'not-started'}, nativeHistory: { restorable: false, reason: repository.runs().some(run=>run.sessionId===session.id)?'native-recovery-not-implemented':'never-started' } });
  }
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
