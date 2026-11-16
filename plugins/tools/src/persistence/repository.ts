import type { OwnerRepository, RepositoryDeclaration, ReadSnapshot, SyncTransaction } from '@aork/sdk/server';
import type { RunToolSnapshot, ToolCallRecord, ToolCallSummary, ToolRef } from '@aork/contracts/tools';
export interface Selection {
    sessionId: string;
    principal: string;
    workspaceId: string;
    revision: number;
    tools: ToolRef[];
    archived: boolean;
}
export interface Grant {
    snapshot: RunToolSnapshot;
    principal: string;
    state: 'planned' | 'live' | 'revoked';
    reason?: string;
}
export const persistence: RepositoryDeclaration = { namespace: 'plugin_tools__', migrations: [{ version: 1, statements: ['CREATE TABLE plugin_tools__selections (id TEXT PRIMARY KEY, record TEXT NOT NULL)', 'CREATE TABLE plugin_tools__grants (id TEXT PRIMARY KEY, record TEXT NOT NULL)', 'CREATE TABLE plugin_tools__calls (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, record TEXT NOT NULL)', "CREATE INDEX plugin_tools__grant_session ON plugin_tools__grants (json_extract(record,'$.snapshot.sessionId'))", "CREATE INDEX plugin_tools__grant_run ON plugin_tools__grants (json_extract(record,'$.snapshot.run.runId'))", 'CREATE INDEX plugin_tools__call_session ON plugin_tools__calls (session_id)'] }], statements: {
        selections: { sql: 'SELECT record FROM plugin_tools__selections ORDER BY rowid', mode: 'read' }, selection: { sql: 'SELECT record FROM plugin_tools__selections WHERE id=?', mode: 'read' }, putSelection: { sql: 'INSERT OR REPLACE INTO plugin_tools__selections (id,record) VALUES (?,?)', mode: 'write' },
        activeGrants: { sql: "SELECT record FROM plugin_tools__grants WHERE json_extract(record,'$.state')!='revoked' ORDER BY rowid", mode: 'read' }, sessionGrants: { sql: "SELECT record FROM plugin_tools__grants WHERE json_extract(record,'$.snapshot.sessionId')=? ORDER BY json_extract(record,'$.snapshot.run.generation') DESC, rowid DESC LIMIT 51", mode: 'read' }, runGrant: { sql: "SELECT record FROM plugin_tools__grants WHERE json_extract(record,'$.snapshot.run.runId')=? LIMIT 1", mode: 'read' }, grants: { sql: 'SELECT record FROM plugin_tools__grants ORDER BY rowid', mode: 'read' }, grant: { sql: 'SELECT record FROM plugin_tools__grants WHERE id=?', mode: 'read' }, insertGrant: {sql:'INSERT INTO plugin_tools__grants (id,record) VALUES (?,?)',mode:'write'},updateGrant:{sql:'UPDATE plugin_tools__grants SET record=? WHERE id=?',mode:'write'},
        calls:{sql:"SELECT json_remove(record,'$.result') AS record, json_type(record,'$.result') IS NOT NULL AS has_result FROM plugin_tools__calls WHERE session_id=? ORDER BY rowid DESC LIMIT 101",mode:'read'},activeCalls:{sql:"SELECT json_remove(record,'$.result') AS record,json_type(record,'$.result') IS NOT NULL AS has_result FROM plugin_tools__calls WHERE session_id=? AND json_extract(record,'$.state')='running' ORDER BY rowid DESC",mode:'read'},call:{sql:'SELECT record FROM plugin_tools__calls WHERE id=?',mode:'read'},hasCall:{sql:'SELECT id FROM plugin_tools__calls WHERE id=?',mode:'read'}, unfinished: { sql: "SELECT record FROM plugin_tools__calls WHERE json_extract(record,'$.state')='running'", mode: 'read' }, insertCall:{sql:'INSERT INTO plugin_tools__calls (id,session_id,record) VALUES (?,?,?)',mode:'write'},updateCall:{sql:'UPDATE plugin_tools__calls SET record=? WHERE id=?',mode:'write'},
    } };
export function toolRepository(binding: OwnerRepository) {
    const all = <T>(name: string, values: string[] = [], tx?: SyncTransaction | ReadSnapshot) => binding.all<{
        record: string;
    }>(name, values, tx).map(row => JSON.parse(row.record) as T);
    const summaries=(name:string,id:string,tx?:SyncTransaction|ReadSnapshot):ToolCallSummary[]=>binding.all<{record:string;has_result:number}>(name,[id],tx).map(row=>({...JSON.parse(row.record),resultOmitted:row.has_result===1}));
    return { selections: (tx?: SyncTransaction) => all<Selection>('selections', [], tx), selection: (id: string, tx?: SyncTransaction | ReadSnapshot) => all<Selection>('selection', [id], tx)[0], putSelection: (tx: SyncTransaction, value: Selection) => binding.run(tx, 'putSelection', [value.sessionId, JSON.stringify(value)]),
        activeGrants: (tx?: SyncTransaction) => all<Grant>('activeGrants', [], tx), sessionGrants: (id: string, tx?: SyncTransaction | ReadSnapshot) => all<Grant>('sessionGrants', [id], tx).reverse(), runGrant: (id: string, tx?: SyncTransaction | ReadSnapshot) => all<Grant>('runGrant', [id], tx)[0],
        grants: (tx?: SyncTransaction | ReadSnapshot) => all<Grant>('grants', [], tx), grant: (id: string, tx?: SyncTransaction) => all<Grant>('grant', [id], tx)[0], putGrant(tx:SyncTransaction,value:Grant){const id=value.snapshot.grantId;const record=JSON.stringify(value);return all<Grant>('grant',[id],tx).length?binding.run(tx,'updateGrant',[record,id]):binding.run(tx,'insertGrant',[id,record]);},
        calls:(sessionId:string,tx?:SyncTransaction|ReadSnapshot)=>summaries('calls',sessionId,tx),activeCalls:(sessionId:string,tx?:SyncTransaction|ReadSnapshot)=>summaries('activeCalls',sessionId,tx),call:(id:string,tx?:SyncTransaction|ReadSnapshot)=>all<ToolCallRecord>('call',[id],tx)[0], unfinished: (tx?:SyncTransaction) => all<ToolCallRecord>('unfinished',[],tx), putCall(tx:SyncTransaction,value:ToolCallRecord){return binding.all('hasCall',[value.id],tx).length?binding.run(tx,'updateCall',[JSON.stringify(value),value.id]):binding.run(tx,'insertCall',[value.id,value.sessionId,JSON.stringify(value)]);} };
}
