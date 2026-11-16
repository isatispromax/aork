import { z } from 'zod';
import { AorkError, isAorkError } from '@aork/sdk';
import type { ServerPluginContext, ReadSnapshot, SyncTransaction } from '@aork/sdk/server';
import { SESSIONS_SERVICE, type SessionsService } from '@aork/contracts/session';
import { defaultPreferences, preferencesSchema, markReadSchema, pageParametersSchema, replySummarySchema, unreadPageSchema } from '@aork/contracts/workbench';
export { persistence } from './persistence/repository.js';
export function activate(context: ServerPluginContext) {
    const repository = context.repository;
    const changed = { 'workbench.unreadChanged': { version: 1, payload: z.object({ sessionId: z.uuid() }).strict() } };
    let sessions: SessionsService | undefined;
    try {
        sessions = context.service<SessionsService>(SESSIONS_SERVICE);
    }
    catch (error) {
        if (!isAorkError(error) || error.code !== 'SERVICE_UNAVAILABLE')
            throw error;
    }
    if (sessions)
        context.consumeFacts(sessions.replyFacts, { id: 'completedReplyProjection', events: changed, apply(fact, tx) {
                const { principal, source: _source, ...value } = fact.payload;
                const summary = replySummarySchema.parse(value);
                repository.run(tx, 'insert', [summary.activityId, principal, summary.sessionId, JSON.stringify(summary)]);
                return { principal, events: [{ type: 'workbench.unreadChanged', version: 1, entityId: summary.sessionId, payload: { sessionId: summary.sessionId } }] };
            } });
    function unread(identity: string, parameters: Readonly<Record<string, string>>, tx?: ReadSnapshot | SyncTransaction) {
        const parsed = pageParametersSchema.safeParse(parameters);
        if (!parsed.success)
            throw new AorkError('WORKBENCH_QUERY_INVALID', 'Choose a valid page cursor', 400);
        const rows = repository.all<{
            cursor: string;
            record: string;
        }>('list', [identity, parsed.data.after], tx);
        const count = repository.all<{
            count: number;
        }>('count', [identity], tx)[0]!.count;
        return unreadPageSchema.parse({ count, items: rows.slice(0, 50).map(row => JSON.parse(row.record)), ...(rows.length > 50 ? { next: rows[49]!.cursor } : {}) });
    }
    context.snapshot('workbench.unread', { maxBytes: 100000, read(parameters, request, tx) { return unread(request.identity!, parameters, tx); } });
    context.query('workbench.unread', { access: 'authenticated', execute(request) { return unread(request.identity!, {}); } });
    context.durableCommand('workbench.markRead', { version: 1, payload: markReadSchema, result: markReadSchema, events: changed, execute(payload, _p, tx, request) {
            for (const id of payload.activityIds)
                if (!repository.all('get', [request.identity!, payload.sessionId, id], tx).length)
                    throw new AorkError('REPLY_UNAVAILABLE', 'This reply is not projected yet or is unavailable; read it again after synchronization', 404);
            for (const id of payload.activityIds)
                repository.run(tx, 'read', [request.identity!, payload.sessionId, id]);
            return { result: payload, events: [{ type: 'workbench.unreadChanged', version: 1, entityId: payload.sessionId, payload: { sessionId: payload.sessionId } }] };
        } });
    function preferences(identity: string, tx?: ReadSnapshot | SyncTransaction) { const row = repository.all<{
        record: string;
    }>('preferences', [identity], tx)[0]; return preferencesSchema.parse(row ? JSON.parse(row.record) : defaultPreferences); }
    context.snapshot('workbench.preferences', { maxBytes: 10000, read(_parameters, request, tx) { return preferences(request.identity!, tx); } });
    context.query('workbench.preferences', { access: 'authenticated', execute(request) { return preferences(request.identity!); } });
    context.durableCommand('workbench.savePreferences', { version: 1, payload: preferencesSchema, result: preferencesSchema, events: { 'workbench.preferencesChanged': { version: 1, payload: preferencesSchema } }, execute(payload, _p, tx, request) { repository.run(tx, 'savePreferences', [request.identity!, JSON.stringify(payload)]); return { result: payload, events: [{ type: 'workbench.preferencesChanged', version: 1, entityId: request.identity!, payload }] }; } });
    context.provide('aork.workbench@1', { version: 1 });
    context.query('workbench.overview', { access: 'authenticated', execute: () => ({ version: 1, status: 'ready' }) });
}
