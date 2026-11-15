import { randomUUID } from 'node:crypto';
import { AorkError } from '@aork/sdk';
import type { ServerPluginContext } from '@aork/sdk/server';
import { WORKSPACE_SERVICE } from '@aork/contracts/workspace';
import type { WorkspaceService } from '@aork/contracts/workspace';
import { AGENT_PROFILES_SERVICE, AGENT_PROVIDER_REGISTRY } from '@aork/contracts/agent';
import type { AgentProfilesService, AgentProviderRegistry } from '@aork/contracts/agent';
import { SESSIONS_SERVICE, archiveSessionSchema, createSessionSchema, sessionSchema, sessionsOverviewSchema } from '@aork/contracts/session';
import type { SessionsService } from '@aork/contracts/session';
import { sessionRepository } from './persistence/repository.js';
export { persistence } from './persistence/repository.js';

export function activate(context: ServerPluginContext) {
  const repository = sessionRepository(context.repository);
  const workspaces = context.service<WorkspaceService>(WORKSPACE_SERVICE);
  const profiles = context.service<AgentProfilesService>(AGENT_PROFILES_SERVICE);
  const providers = context.service<AgentProviderRegistry>(AGENT_PROVIDER_REGISTRY);
  const participants = new Set<Parameters<SessionsService['registerArchiveParticipant']>[0]>();
  const service: SessionsService = {
    getSession: (id, tx) => repository.get(id, tx)?.session,
    requireOpenSession(id, tx) {
      const session = repository.get(id, tx)?.session;
      if (!session || session.status !== 'open') throw new AorkError('SESSION_UNAVAILABLE', 'Session is archived or unavailable', 409);
      workspaces.requireOpenWorkspace(session.workspaceId, tx);
      return session;
    },
    registerArchiveParticipant(participant) { participants.add(participant); return () => { participants.delete(participant); }; },
  };
  context.provide(SESSIONS_SERVICE, service);
  context.query('sessions.overview', { access: 'authenticated', execute(request) {
    return sessionsOverviewSchema.parse({ sessions: repository.list(request.identity!).map(session => ({ session, execution: { state: 'not-started' }, nativeHistory: { restorable: false, reason: 'never-started' } })) });
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
      for (const participant of participants) {
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
