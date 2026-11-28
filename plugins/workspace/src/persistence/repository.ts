import { sql, type SQL } from 'drizzle-orm';
import { sqliteTable, text, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import type { OwnerRepository, RepositoryDeclaration, SyncTransaction } from '@aork/sdk/server';
import type { Workspace } from '@aork/contracts/workspace';

const workspaces = sqliteTable('plugin_workspace__workspaces', { id: text('id').primaryKey(), record: text('record').notNull() });
const dialect = new SQLiteSyncDialect();
const statement = (query: SQL, mode: 'read' | 'write') => ({ sql: dialect.sqlToQuery(query).sql, mode });
const p = (name: string) => sql.placeholder(name);
export const persistence: RepositoryDeclaration = {
  namespace: 'plugin_workspace__',
  migrations: [{ version: 1, statements: [
    'CREATE TABLE plugin_workspace__workspaces (id TEXT PRIMARY KEY, record TEXT NOT NULL)',
  ] }, {version:2,statements:['CREATE TABLE plugin_workspace__claims (run_id TEXT PRIMARY KEY, record TEXT NOT NULL)']}],
  statements: {
    claims: {sql:'SELECT record FROM plugin_workspace__claims',mode:'read'},
    insertClaim: {sql:'INSERT INTO plugin_workspace__claims (run_id,record) VALUES (?,?)',mode:'write'},
    updateClaim: {sql:'UPDATE plugin_workspace__claims SET record=? WHERE run_id=?',mode:'write'},
    workspaces: statement(sql`SELECT ${workspaces.record} FROM ${workspaces} ORDER BY rowid`, 'read'),
    workspace: statement(sql`SELECT ${workspaces.record} FROM ${workspaces} WHERE ${workspaces.id} = ${p('id')}`, 'read'),
    updateWorkspace: statement(sql`UPDATE ${workspaces} SET record = ${p('record')} WHERE id = ${p('id')}`, 'write'),
    insertWorkspace: statement(sql`INSERT INTO ${workspaces} (id,record) VALUES (${p('id')},${p('record')})`, 'write'),
    deleteWorkspace: statement(sql`DELETE FROM ${workspaces} WHERE ${workspaces.id} = ${p('id')}`, 'write'),
  },
};
export interface WorkspaceClaim { runId:string; workspaceId:string; owner:string; hostEpoch:string; root:string; device:string; inode:string; usedPluginIds:readonly string[]; state:'held'|'blocked'|'released'; reason:string }
export function workspaceRepository(binding: OwnerRepository) {
  return {
    claims: (tx?:SyncTransaction) => binding.all<{record:string}>('claims',[],tx).map(row=>JSON.parse(row.record) as WorkspaceClaim),
    insertClaim(tx:SyncTransaction, claim:WorkspaceClaim) {binding.run(tx,'insertClaim',[claim.runId,JSON.stringify(claim)]);},
    updateClaim(tx:SyncTransaction, claim:WorkspaceClaim) {binding.run(tx,'updateClaim',[JSON.stringify(claim),claim.runId]);},
    workspaces: (tx?: SyncTransaction) => binding.all<{ record: string }>('workspaces', [], tx).map(row => JSON.parse(row.record) as Workspace),
    workspace: (id: string, tx?: SyncTransaction) => { const row = binding.all<{ record: string }>('workspace', [id], tx)[0]; return row ? JSON.parse(row.record) as Workspace : undefined; },
    updateWorkspace(tx: SyncTransaction, workspace: Workspace) { binding.run(tx, 'updateWorkspace', [JSON.stringify(workspace), workspace.id]); },
    insertWorkspace(tx: SyncTransaction, workspace: Workspace) { binding.run(tx, 'insertWorkspace', [workspace.id, JSON.stringify(workspace)]); },
    deleteWorkspace(tx: SyncTransaction, id: string) { binding.run(tx, 'deleteWorkspace', [id]); },
  };
}
