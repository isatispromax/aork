import { sql, type SQL } from 'drizzle-orm';
import { sqliteTable, text, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { repositoryNamespace } from '@aork/sdk/server';
import type { OwnerRepository, RepositoryDeclaration, SyncTransaction, ReadSnapshot } from '@aork/sdk/server';
import type { Reconciliation } from '@aork/contracts/reconciliation';
import type { PromptContent } from '@aork/contracts/input';
import { sessionSchema } from '@aork/contracts/session';
import type { RuntimeRun } from '@aork/contracts/runtime';
import type { Session, Turn, SessionTimeline } from '@aork/contracts/session';
const namespace = repositoryNamespace('sessions');
const sessions = sqliteTable(`${namespace}sessions`, { id: text('id').primaryKey(), principal: text('principal').notNull(), record: text('record').notNull() });
const dialect = new SQLiteSyncDialect(); const p = (key: string) => sql.placeholder(key);
const statement = (query: SQL, mode: 'read' | 'write') => ({ sql: dialect.sqlToQuery(query).sql, mode });
export const persistence: RepositoryDeclaration = {
  namespace, migrations: [{ version: 1, statements: [
    `CREATE TABLE ${namespace}sessions (id TEXT PRIMARY KEY, principal TEXT NOT NULL, record TEXT NOT NULL)`,
    `CREATE INDEX ${namespace}principal ON ${namespace}sessions(principal)`,
  ] },{version:2,statements:[`CREATE TABLE ${namespace}runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, record TEXT NOT NULL)`]}, {version:3,statements:[
    `CREATE TABLE ${namespace}turns (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, record TEXT NOT NULL)`,
    `CREATE TABLE ${namespace}messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, record TEXT NOT NULL)`,
    `CREATE TABLE ${namespace}tools (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, record TEXT NOT NULL)`,
    `CREATE TABLE ${namespace}paused (session_id TEXT PRIMARY KEY)`,
  ]},{version:4,statements:[`CREATE TABLE ${namespace}inputs (id TEXT PRIMARY KEY, record TEXT NOT NULL)`]},{version:5,statements:[`CREATE TABLE ${namespace}reconciliation (run_id TEXT PRIMARY KEY, record TEXT NOT NULL)`]},{version:6,statements:[`CREATE TABLE ${namespace}replies (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, message_count INTEGER NOT NULL)`]}], statements: {
    insertReply:{sql:`INSERT INTO ${namespace}replies (id,session_id,message_count) VALUES (?,?,?)`,mode:'write'},
    replies:{sql:`SELECT id, message_count FROM ${namespace}replies WHERE session_id=? ORDER BY rowid`,mode:'read'},
    replyMessages:{sql:`SELECT record FROM ${namespace}messages WHERE session_id=? AND json_extract(record,'$.turnId')=? AND json_extract(record,'$.role')='agent' AND json_extract(record,'$.sequence')>? ORDER BY json_extract(record,'$.sequence') LIMIT 51`,mode:'read'},
    agentMessageCount:{sql:`SELECT count(*) AS count FROM ${namespace}messages WHERE session_id=? AND json_extract(record,'$.turnId')=? AND json_extract(record,'$.role')='agent'`,mode:'read'},
    input:{sql:`SELECT record FROM ${namespace}inputs WHERE id=?`,mode:'read'},
    insertInput:{sql:`INSERT INTO ${namespace}inputs (id,record) VALUES (?,?)`,mode:'write'},
    turns:{sql:`SELECT rowid AS ordinal,record FROM ${namespace}turns ORDER BY rowid`,mode:'read'},
    turn:{sql:`SELECT rowid AS ordinal,record FROM ${namespace}turns WHERE id=?`,mode:'read'},
    insertTurn:{sql:`INSERT INTO ${namespace}turns (id,session_id,record) VALUES (?,?,?)`,mode:'write'},
    dispatchTurn:{sql:`UPDATE ${namespace}turns SET record=? WHERE id=? AND json_extract(record,'$.state') IN ('accepted','queued')`,mode:'write'},
    message:{sql:`SELECT record FROM ${namespace}messages WHERE id=?`,mode:'read'},
    resume:{sql:`DELETE FROM ${namespace}paused WHERE session_id=?`,mode:'write'},
    updateTurn:{sql:`UPDATE ${namespace}turns SET record=? WHERE id=?`,mode:'write'},
    messages:{sql:`SELECT record FROM ${namespace}messages WHERE session_id=? ORDER BY rowid DESC LIMIT 1000`,mode:'read'},
    tools:{sql:`SELECT record FROM ${namespace}tools WHERE session_id=? ORDER BY rowid DESC LIMIT 200`,mode:'read'},
    insertMessage:{sql:`INSERT INTO ${namespace}messages (id,session_id,record) VALUES (?,?,?)`,mode:'write'},
    putTool:{sql:`INSERT OR REPLACE INTO ${namespace}tools (id,session_id,record) VALUES (?,?,?)`,mode:'write'},
    paused:{sql:`SELECT session_id FROM ${namespace}paused WHERE session_id=?`,mode:'read'},
    pause:{sql:`INSERT OR IGNORE INTO ${namespace}paused (session_id) VALUES (?)`,mode:'write'},
    runs:{sql:`SELECT record FROM ${namespace}runs ORDER BY rowid`,mode:'read'},
    run:{sql:`SELECT record FROM ${namespace}runs WHERE id=?`,mode:'read'},
    insertRun:{sql:`INSERT INTO ${namespace}runs (id,session_id,record) VALUES (?,?,?)`,mode:'write'},
    updateRun:{sql:`UPDATE ${namespace}runs SET record=? WHERE id=?`,mode:'write'},
    list: statement(sql`SELECT record FROM ${sessions} WHERE principal = ${p('principal')} ORDER BY rowid`, 'read'),
    get: statement(sql`SELECT principal,record FROM ${sessions} WHERE id = ${p('id')}`, 'read'),
    insert: statement(sql`INSERT INTO ${sessions} (id,principal,record) VALUES (${p('id')},${p('principal')},${p('record')})`, 'write'),
    update: statement(sql`UPDATE ${sessions} SET record = ${p('record')} WHERE id = ${p('id')}`, 'write'),
    reconciliation:{sql:`SELECT record FROM ${namespace}reconciliation WHERE run_id=?`,mode:'read'},
    putReconciliation:{sql:`INSERT OR REPLACE INTO ${namespace}reconciliation (run_id,record) VALUES (?,?)`,mode:'write'},
  },
};
function readTurn(row:{ordinal:number;record:string}):Turn { const value=JSON.parse(row.record);return {...value,state:value.state==='accepted'?'queued':value.state,acceptanceOrder:value.acceptanceOrder??row.ordinal}; }
export function sessionRepository(binding: OwnerRepository) {
  return {
    replyMessages(sessionId:string,turnId:string,after:number,tx?:SyncTransaction|ReadSnapshot){return binding.all<{record:string}>('replyMessages',[sessionId,turnId,after],tx).map(row=>JSON.parse(row.record) as SessionTimeline['messages'][number]);},
    agentMessageCount(sessionId:string,turnId:string,tx?:SyncTransaction|ReadSnapshot){return binding.all<{count:number}>('agentMessageCount',[sessionId,turnId],tx)[0]!.count;},
    insertReply(tx:SyncTransaction,sessionId:string,turnId:string,count:number){binding.run(tx,'insertReply',[turnId,sessionId,count]);},
    replies(sessionId:string,tx?:SyncTransaction|ReadSnapshot){return binding.all<{id:string;message_count:number}>('replies',[sessionId],tx);},
    reconciliation(id:string,tx?:SyncTransaction|ReadSnapshot){const row=binding.all<{record:string}>('reconciliation',[id],tx)[0];return row?JSON.parse(row.record) as Reconciliation:undefined;},
    putReconciliation(tx:SyncTransaction,value:Reconciliation){binding.run(tx,'putReconciliation',[value.runId,JSON.stringify(value)]);},
    input:(id:string,tx?:SyncTransaction|ReadSnapshot)=>{const row=binding.all<{record:string}>('input',[id],tx)[0];return row?JSON.parse(row.record) as PromptContent[]:undefined;},
    insertInput(tx:SyncTransaction,id:string,content:PromptContent[]){binding.run(tx,'insertInput',[id,JSON.stringify(content)]);},
    dispatchTurn(tx:SyncTransaction,turn:Turn){return binding.run(tx,'dispatchTurn',[JSON.stringify(turn),turn.id]).changes===1;},
    message(id:string,tx?:SyncTransaction|ReadSnapshot){const row=binding.all<{record:string}>('message',[id],tx)[0];return row?JSON.parse(row.record) as SessionTimeline['messages'][number]:undefined;},
    resume(tx:SyncTransaction,id:string){binding.run(tx,'resume',[id]);},
    turns:(tx?:SyncTransaction|ReadSnapshot)=>binding.all<{ordinal:number;record:string}>('turns',[],tx).map(readTurn),
    turn(id:string,tx?:SyncTransaction|ReadSnapshot){const row=binding.all<{ordinal:number;record:string}>('turn',[id],tx)[0];return row?readTurn(row):undefined;},
    insertTurn(tx:SyncTransaction,turn:Turn){binding.run(tx,'insertTurn',[turn.id,turn.sessionId,JSON.stringify(turn)]);},
    updateTurn(tx:SyncTransaction,turn:Turn){binding.run(tx,'updateTurn',[JSON.stringify(turn),turn.id]);},
    messages:(id:string,tx?:SyncTransaction|ReadSnapshot)=>binding.all<{record:string}>('messages',[id],tx).reverse().map(row=>JSON.parse(row.record) as SessionTimeline['messages'][number]),
    tools:(id:string,tx?:SyncTransaction|ReadSnapshot)=>binding.all<{record:string}>('tools',[id],tx).reverse().map(row=>JSON.parse(row.record) as SessionTimeline['tools'][number]),
    insertMessage(tx:SyncTransaction,sessionId:string,message:SessionTimeline['messages'][number]){binding.run(tx,'insertMessage',[message.id,sessionId,JSON.stringify(message)]);},
    putTool(tx:SyncTransaction,sessionId:string,tool:SessionTimeline['tools'][number]){binding.run(tx,'putTool',[`${tool.turnId}:${tool.toolCallId}`,sessionId,JSON.stringify(tool)]);},
    paused:(id:string,tx?:SyncTransaction|ReadSnapshot)=>binding.all('paused',[id],tx).length>0,
    pause(tx:SyncTransaction,id:string){binding.run(tx,'pause',[id]);},
    runs:(tx?:SyncTransaction|ReadSnapshot)=>binding.all<{record:string}>('runs',[],tx).map(row=>JSON.parse(row.record) as RuntimeRun),
    run(id:string,tx?:SyncTransaction|ReadSnapshot){const row=binding.all<{record:string}>('run',[id],tx)[0];return row?JSON.parse(row.record) as RuntimeRun:undefined;},
    insertRun(tx:SyncTransaction,run:RuntimeRun){binding.run(tx,'insertRun',[run.runId,run.sessionId,JSON.stringify(run)]);},
    updateRun(tx:SyncTransaction,run:RuntimeRun){binding.run(tx,'updateRun',[JSON.stringify(run),run.runId]);},
    list: (principal: string,tx?:SyncTransaction|ReadSnapshot) => binding.all<{ record: string }>('list', [principal],tx).map(row => sessionSchema.parse(JSON.parse(row.record))),
    get(id: string, tx?: SyncTransaction|ReadSnapshot) { const row = binding.all<{ principal: string; record: string }>('get', [id], tx)[0]; return row ? { principal: row.principal, session: sessionSchema.parse(JSON.parse(row.record)) } : undefined; },
    insert(tx: SyncTransaction, principal: string, session: Session) { binding.run(tx, 'insert', [session.id, principal, JSON.stringify(session)]); },
    update(tx: SyncTransaction, session: Session) { binding.run(tx, 'update', [JSON.stringify(session), session.id]); },
  };
}
