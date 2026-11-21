import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AorkError } from '@aork/sdk';
import {completedReplyFactSchema} from '@aork/contracts/session';
import { sessionSchema } from '@aork/contracts/session';
import type { SessionsService } from '@aork/contracts/session';
import type { RepositoryDeclaration, ServerPluginContext } from '@aork/sdk/server';
import { WORKSPACE_SERVICE } from '@aork/contracts/workspace';
import type { WorkspaceService } from '@aork/contracts/workspace';
import { AGENT_PROFILES_SERVICE } from '@aork/contracts/agent';
import type { AgentProfilesService } from '@aork/contracts/agent';
import { ACP_RUNTIME, runSchema } from '@aork/contracts/runtime';
import type { AcpRuntime, RuntimeRun } from '@aork/contracts/runtime';
import { TOOLS_SERVICE, toolRefSchema } from '@aork/contracts/tools';
import type { ToolsService } from '@aork/contracts/tools';
/** Independent Session lifecycle implementation using the public admission/fact seams. */
export const persistence: RepositoryDeclaration = { namespace: 'plugin_planned_hrun_howner__', migrations: [{ version: 1, statements: ['CREATE TABLE plugin_planned_hrun_howner__sessions (id TEXT PRIMARY KEY, record TEXT NOT NULL)', 'CREATE TABLE plugin_planned_hrun_howner__runs (id TEXT PRIMARY KEY, principal TEXT NOT NULL, record TEXT NOT NULL)'] }], statements: { session: { sql: 'SELECT record FROM plugin_planned_hrun_howner__sessions WHERE id=?', mode: 'read' }, putSession: { sql: 'INSERT INTO plugin_planned_hrun_howner__sessions (id,record) VALUES (?,?)', mode: 'write' }, insert: { sql: 'INSERT INTO plugin_planned_hrun_howner__runs (id,principal,record) VALUES (?,?,?)', mode: 'write' }, get: { sql: 'SELECT principal,record FROM plugin_planned_hrun_howner__runs WHERE id=?', mode: 'read' }, list: { sql: 'SELECT record FROM plugin_planned_hrun_howner__runs WHERE principal=?', mode: 'read' }, update: { sql: 'UPDATE plugin_planned_hrun_howner__runs SET record=? WHERE id=?', mode: 'write' } } };
export function activate(context: ServerPluginContext) {
    const workspace = context.service<WorkspaceService>(WORKSPACE_SERVICE);
    const profiles = context.service<AgentProfilesService>(AGENT_PROFILES_SERVICE);
    const runtime = context.service<AcpRuntime>(ACP_RUNTIME);
    const tools = context.service<ToolsService>(TOOLS_SERVICE);
    const participants = new Map<string, Parameters<SessionsService['registerArchiveParticipant']>[0]>();
    const replies=context.factStream('completedReplies',completedReplyFactSchema);
    const sessions: SessionsService = {replyFacts:replies.source, getSession(id, tx) { const row = context.repository.all<{
            record: string;
        }>('session', [id], tx)[0]; return row ? sessionSchema.parse(JSON.parse(row.record)) : undefined; }, requireOpenSession(id, tx) { const session = sessions.getSession(id, tx); if (!session || session.status !== 'open')
            throw new AorkError('SESSION_UNAVAILABLE', 'Session is unavailable', 409); workspace.requireOpenWorkspace(session.workspaceId, tx); return session; }, registerArchiveParticipant(participant) { if (participants.has(participant.id))
            throw new AorkError('SESSION_ARCHIVE_POLICY_CONFLICT', 'Archive participant already exists', 409); participants.set(participant.id, participant); return () => { if (participants.get(participant.id) === participant)
            participants.delete(participant.id); }; }, registerArtifactVersions(_reader) { return () => { }; }, requireSource(_principal, source) { const session = sessions.getSession(source.sessionId); if (!session || session.status !== 'open')
            throw new AorkError('SESSION_SOURCE_UNAVAILABLE', 'Choose an owned Session and an existing, non-removed Turn', 404); return { sessionId: source.sessionId, turnId: source.turnId, workspaceId: session.workspaceId }; } };
    context.provide('aork.sessions@1', sessions);
    context.consumeFacts(runtime.facts, { id: 'runProjection', events: {}, apply(fact, tx) { const row = context.repository.all<{
            principal: string;
            record: string;
        }>('get', [fact.entityId], tx)[0]; if (!row)
            return { principal: '', events: [] }; const previous = runSchema.parse(JSON.parse(row.record)); const run = runSchema.parse({ ...previous, ...fact.payload.details, state: fact.payload.state }); context.repository.run(tx, 'update', [JSON.stringify(run), run.runId]); if (run.state === 'stopped')
            workspace.releaseClaim(tx, context.owner, run.runId);
        else if (run.state === 'unknown')
            workspace.blockClaim(tx, context.owner, run.runId, 'Execution remains unknown'); return { principal: row.principal, events: [] }; } });
    context.query('plannedRuns.list', { access: 'authenticated', execute(request) { return { runs: context.repository.all<{
                record: string;
            }>('list', [request.identity!]).map(row => runSchema.parse(JSON.parse(row.record))) }; } });
    context.command('plannedRuns.startAndShutdown', { access: 'authenticated', async execute(value, request) {
            const input = z.object({ workspaceId: z.uuid(), profileId: z.uuid(), tools: z.array(toolRefSchema).max(8) }).strict().parse(value);
            const agent = await profiles.prepareLaunch(profiles.snapshot(input.profileId));
            return runtime.withAdmission([], () => workspace.withWritePermission(input.workspaceId, () => {
                const run = context.transactions.run(tx => { const current = workspace.requireOpenWorkspace(input.workspaceId, tx); const runRef = { runId: randomUUID(), generation: 1, hostEpoch: context.owner.hostEpoch }; const sessionId = randomUUID(); const { stateDirectory: _private, ...profile } = agent.profile; const session = sessionSchema.parse({ id: sessionId, name: 'Independent lifecycle admission', workspaceId: current.id, profileId: profile.id, status: 'open', createdAt: new Date().toISOString(), workspace: current, profile, providerLabel: 'Controlled Agent' }); context.repository.run(tx, 'putSession', [sessionId, JSON.stringify(session)]); tools.createSelection(tx, { sessionId, principal: request.identity!, workspaceId: current.id }, input.tools); const snapshot = tools.captureRun(tx, { sessionId, run: runRef }); const usedPluginIds = [...new Set([context.pluginId, agent.providerOwner.pluginId, ...snapshot.tools.map(tool => tool.ownerPluginId), ...Object.values(context.owner.serviceOwners).map(owner => owner.pluginId)])]; const run: RuntimeRun = runSchema.parse({ ...runRef, sessionId, state: 'starting', directory: current.directory, profileRevision: agent.profile.revision, providerDefinitionVersion: agent.providerDefinitionVersion, detectedVersion: agent.detectedVersion, runtime: runtime.versions, environment: { inherited: false, names: runtime.environmentNames }, pluginGraphHash: context.owner.pluginGraphHash, usedPluginIds, tools: { grantId: snapshot.grantId, selectionRevision: snapshot.selectionRevision, tools: input.tools } }); const claim = workspace.reserveClaim(tx, context.owner, run.runId, current.id, usedPluginIds); context.repository.run(tx, 'insert', [run.runId, request.identity!, JSON.stringify(run)]); runtime.acceptStart(tx, { run, toolSnapshot: snapshot, principal: request.identity!, claim, owner: context.owner, workspace: current, agent }); return run; });
                // The real admission transaction has committed. Stop via the public lifecycle method
                // in this same callback before yielding, so the Runtime dispatch timer cannot race it.
                const stopping = runtime.shutdown();
                return stopping.then(() => ({ run }));
            }));
        } });
}
