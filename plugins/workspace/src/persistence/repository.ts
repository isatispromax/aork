import { sql, type SQL } from 'drizzle-orm';
import { sqliteTable, text, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import type { OwnerRepository, RepositoryDeclaration, SyncTransaction } from '@aork/sdk/server';
import type { Project, Workspace } from '@aork/contracts/workspace';

const projects = sqliteTable('plugin_workspace_projects', { id: text('id').primaryKey(), name: text('name').notNull(), status: text('status').notNull() });
const workspaces = sqliteTable('plugin_workspace_workspaces', { id: text('id').primaryKey(), projectId: text('project_id').notNull().references(() => projects.id), record: text('record').notNull() });
const dialect = new SQLiteSyncDialect();
const statement = (query: SQL, mode: 'read' | 'write') => ({ sql: dialect.sqlToQuery(query).sql, mode });
const p = (name: string) => sql.placeholder(name);
export const persistence: RepositoryDeclaration = {
  namespace: 'plugin_workspace_',
  migrations: [{ version: 1, statements: [
    "CREATE TABLE plugin_workspace_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','archived')))",
    'CREATE TABLE plugin_workspace_workspaces (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES plugin_workspace_projects(id), record TEXT NOT NULL)',
    'CREATE INDEX plugin_workspace_project_id ON plugin_workspace_workspaces(project_id)',
  ] }],
  statements: {
    projects: statement(sql`SELECT * FROM ${projects} ORDER BY rowid`, 'read'),
    workspaces: statement(sql`SELECT ${workspaces.record} FROM ${workspaces} ORDER BY rowid`, 'read'),
    project: statement(sql`SELECT * FROM ${projects} WHERE ${projects.id} = ${p('id')}`, 'read'),
    workspace: statement(sql`SELECT ${workspaces.record} FROM ${workspaces} WHERE ${workspaces.id} = ${p('id')}`, 'read'),
    updateProject: statement(sql`UPDATE ${projects} SET name = ${p('name')}, status = ${p('status')} WHERE id = ${p('id')}`, 'write'),
    updateWorkspace: statement(sql`UPDATE ${workspaces} SET record = ${p('record')} WHERE id = ${p('id')}`, 'write'),
    insertProject: statement(sql`INSERT INTO ${projects} (id,name,status) VALUES (${p('id')},${p('name')},${p('status')})`, 'write'),
    insertWorkspace: statement(sql`INSERT INTO ${workspaces} (id,project_id,record) VALUES (${p('id')},${p('projectId')},${p('record')})`, 'write'),
  },
};
export function workspaceRepository(binding: OwnerRepository) {
  return {
    projects: () => binding.all<Project>('projects'),
    workspaces: () => binding.all<{ record: string }>('workspaces').map(row => JSON.parse(row.record) as Workspace),
    project: (id: string, tx?: SyncTransaction) => binding.all<Project>('project', [id], tx)[0],
    workspace: (id: string, tx?: SyncTransaction) => { const row = binding.all<{ record: string }>('workspace', [id], tx)[0]; return row ? JSON.parse(row.record) as Workspace : undefined; },
    updateProject(tx: SyncTransaction, project: Project) { binding.run(tx, 'updateProject', [project.name, project.status, project.id]); },
    updateWorkspace(tx: SyncTransaction, workspace: Workspace) { binding.run(tx, 'updateWorkspace', [JSON.stringify(workspace), workspace.id]); },
    insertProject(tx: SyncTransaction, project: Project) { binding.run(tx, 'insertProject', [project.id, project.name, project.status]); },
    insertWorkspace(tx: SyncTransaction, workspace: Workspace) { binding.run(tx, 'insertWorkspace', [workspace.id, workspace.projectId, JSON.stringify(workspace)]); },
  };
}
