import { sql, type SQL } from 'drizzle-orm';
import { sqliteTable, text, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { repositoryNamespace } from '@aork/sdk/server';
import type { OwnerRepository, RepositoryDeclaration, SyncTransaction } from '@aork/sdk/server';
import { sessionSchema } from '@aork/contracts/session';
import type { RuntimeRun } from '@aork/contracts/runtime';
import type { Session } from '@aork/contracts/session';
const namespace = repositoryNamespace('sessions');
const sessions = sqliteTable(`${namespace}sessions`, { id: text('id').primaryKey(), principal: text('principal').notNull(), record: text('record').notNull() });
const dialect = new SQLiteSyncDialect(); const p = (key: string) => sql.placeholder(key);
const statement = (query: SQL, mode: 'read' | 'write') => ({ sql: dialect.sqlToQuery(query).sql, mode });
export const persistence: RepositoryDeclaration = {
  namespace, migrations: [{ version: 1, statements: [
    `CREATE TABLE ${namespace}sessions (id TEXT PRIMARY KEY, principal TEXT NOT NULL, record TEXT NOT NULL)`,
    `CREATE INDEX ${namespace}principal ON ${namespace}sessions(principal)`,
  ] },{version:2,statements:[`CREATE TABLE ${namespace}runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, record TEXT NOT NULL)`]}], statements: {
    runs:{sql:`SELECT record FROM ${namespace}runs ORDER BY rowid`,mode:'read'},
    run:{sql:`SELECT record FROM ${namespace}runs WHERE id=?`,mode:'read'},
    insertRun:{sql:`INSERT INTO ${namespace}runs (id,session_id,record) VALUES (?,?,?)`,mode:'write'},
    updateRun:{sql:`UPDATE ${namespace}runs SET record=? WHERE id=?`,mode:'write'},
    list: statement(sql`SELECT record FROM ${sessions} WHERE principal = ${p('principal')} ORDER BY rowid`, 'read'),
    get: statement(sql`SELECT principal,record FROM ${sessions} WHERE id = ${p('id')}`, 'read'),
    insert: statement(sql`INSERT INTO ${sessions} (id,principal,record) VALUES (${p('id')},${p('principal')},${p('record')})`, 'write'),
    update: statement(sql`UPDATE ${sessions} SET record = ${p('record')} WHERE id = ${p('id')}`, 'write'),
  },
};
export function sessionRepository(binding: OwnerRepository) {
  return {
    runs:(tx?:SyncTransaction)=>binding.all<{record:string}>('runs',[],tx).map(row=>JSON.parse(row.record) as RuntimeRun),
    run(id:string,tx?:SyncTransaction){const row=binding.all<{record:string}>('run',[id],tx)[0];return row?JSON.parse(row.record) as RuntimeRun:undefined;},
    insertRun(tx:SyncTransaction,run:RuntimeRun){binding.run(tx,'insertRun',[run.runId,run.sessionId,JSON.stringify(run)]);},
    updateRun(tx:SyncTransaction,run:RuntimeRun){binding.run(tx,'updateRun',[JSON.stringify(run),run.runId]);},
    list: (principal: string) => binding.all<{ record: string }>('list', [principal]).map(row => sessionSchema.parse(JSON.parse(row.record))),
    get(id: string, tx?: SyncTransaction) { const row = binding.all<{ principal: string; record: string }>('get', [id], tx)[0]; return row ? { principal: row.principal, session: sessionSchema.parse(JSON.parse(row.record)) } : undefined; },
    insert(tx: SyncTransaction, principal: string, session: Session) { binding.run(tx, 'insert', [session.id, principal, JSON.stringify(session)]); },
    update(tx: SyncTransaction, session: Session) { binding.run(tx, 'update', [JSON.stringify(session), session.id]); },
  };
}
