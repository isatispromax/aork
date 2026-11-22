import { afterEach, expect, test } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createDurableStorage } from '../packages/storage/src/durable.js';
import { persistence as workspacePersistence, workspaceRepository } from '../plugins/workspace/src/persistence/repository.js';
import { persistence as artifactsPersistence, artifactRepository } from '../plugins/artifacts/src/persistence/repository.js';
import type { Workspace } from '@aork/contracts/workspace';
import type { Artifact } from '@aork/contracts/artifact';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function freshStorage() {
  const directory = join(tmpdir(), `aork-persistence-${crypto.randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const sqlite = new Database(join(directory, 'aork.sqlite'));
  cleanup.push(async () => { sqlite.close(); await rm(directory, { recursive: true, force: true }); });
  return { storage: createDurableStorage(sqlite), sqlite };
}

const externalWorkspace = (): Workspace => ({
  id: crypto.randomUUID(), name: 'Env', status: 'open',
  requestedDirectory: '/srv/env', directory: '/srv/env', access: 'read-write',
  scope: { root: '/srv/env', recursive: true }, directoryIdentity: { device: 'd1', inode: '42' },
});

test('workspace persistence creates only workspaces and claims tables and round-trips a workspace record', async () => {
  const { storage, sqlite } = await freshStorage();
  const repository = workspaceRepository(storage.bind('workspace', workspacePersistence));
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'plugin_workspace__%' ORDER BY name").all() as Array<{ name: string }>;
  expect(tables.map(table => table.name)).toEqual(['plugin_workspace__claims', 'plugin_workspace__workspaces']);
  const workspace = externalWorkspace();
  storage.transaction(token => repository.insertWorkspace(token, workspace));
  expect(repository.workspaces()).toEqual([workspace]);
  expect(repository.workspace(workspace.id)).toEqual(workspace);
  expect(repository.workspaces()[0]).not.toHaveProperty('projectId');
});

test('artifacts persistence records and lists artifacts by workspace', async () => {
  const { storage } = await freshStorage();
  const repository = artifactRepository(storage.bind('artifacts', artifactsPersistence));
  const artifact: Artifact = { id: crypto.randomUUID(), workspaceId: crypto.randomUUID(), title: 'Notes', createdAt: new Date().toISOString(), archived: false };
  storage.transaction(token => repository.insertArtifact(token, 'principal-1', artifact));
  // The list cursor excludes ids at or below it (`id > ?`); the all-zero uuid sorts below every UUIDv4, keeping the assertion deterministic.
  const cursor = '00000000-0000-0000-0000-000000000000';
  expect(repository.list('principal-1', artifact.workspaceId, cursor)).toEqual([artifact]);
  expect(repository.list('principal-1', crypto.randomUUID(), cursor)).toEqual([]);
  expect(repository.list('principal-2', artifact.workspaceId, cursor)).toEqual([]);
});

test('a data directory created by the previous schema refuses the rewritten declarations with a checksum error', async () => {
  const { storage } = await freshStorage();
  const legacyWorkspacePersistence = {
    namespace: 'plugin_workspace__',
    migrations: [{ version: 1, statements: [
      "CREATE TABLE plugin_workspace__projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','archived')))",
      'CREATE TABLE plugin_workspace__workspaces (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES plugin_workspace__projects(id), record TEXT NOT NULL)',
      'CREATE INDEX plugin_workspace__project_id ON plugin_workspace__workspaces(project_id)',
    ] }, { version: 2, statements: ['CREATE TABLE plugin_workspace__claims (run_id TEXT PRIMARY KEY, record TEXT NOT NULL)'] }],
    statements: {},
  } as const;
  storage.bind('workspace', legacyWorkspacePersistence);
  let message = '';
  try { storage.bind('workspace', workspacePersistence); } catch (error) { message = error instanceof Error ? error.message : String(error); }
  // The data-discardable upgrade path: the error must point at clearing the data directory, never claim data corruption.
  expect(message).toContain('Plugin migration checksum changed');
  expect(message).toMatch(/clear the data directory/i);
  expect(message.toLowerCase()).not.toContain('corrupt');
});
