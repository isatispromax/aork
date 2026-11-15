import { randomUUID } from 'node:crypto';
import { access, mkdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { AorkError } from '@aork/sdk';
import type { ServerPluginContext } from '@aork/sdk/server';
import { WORKSPACE_SERVICE, createProjectSchema, createProjectResultSchema, workspaceOverviewSchema, workspaceSchema, projectSchema, createWorkspaceSchema, editProjectSchema, entityIdSchema, editWorkspaceSchema, workspaceInputSchema } from '@aork/contracts/workspace';
import type { z } from 'zod';
import type { Workspace, WorkspaceService } from '@aork/contracts/workspace';
import { workspaceRepository } from './persistence/repository.js';
export { persistence } from './persistence/repository.js';

export function activate(context: ServerPluginContext) {
  const repository = workspaceRepository(context.repository);
  const service: WorkspaceService = {
    getWorkspace: repository.workspace,
    requireOpenWorkspace(id, transaction) {
      const workspace = repository.workspace(id, transaction);
      if (!workspace || workspace.status !== 'open' || repository.project(workspace.projectId, transaction)?.status !== 'open') throw new AorkError('WORKSPACE_UNAVAILABLE', 'Workspace or its Project is archived or unavailable', 409);
      return workspace;
    },
  };
  context.provide(WORKSPACE_SERVICE, service);
  context.query('workspace.overview', { access: 'authenticated', execute: () => workspaceOverviewSchema.parse({ projects: repository.projects(), workspaces: repository.workspaces() }) });
  async function prepareWorkspace(projectId: string, input: z.infer<typeof workspaceInputSchema>): Promise<Workspace> {
    const workspaceId = randomUUID();
    try {
      const requestedDirectory = input.management === 'external' ? input.directory : join(context.directories.managedWorkspaces, workspaceId);
      if (!isAbsolute(requestedDirectory)) throw new Error('Directory must be absolute');
      if (input.management === 'managed') {
        await mkdir(context.directories.managedWorkspaces, { recursive: true, mode: 0o700 });
        if (await realpath(context.directories.managedWorkspaces) !== context.directories.managedWorkspaces) throw new Error('Managed root was redirected');
        await mkdir(requestedDirectory, { mode: 0o700 });
      }
      const directory = await realpath(requestedDirectory); const facts = await stat(directory, { bigint: true });
      if (!facts.isDirectory()) throw new Error('Not a directory');
      await access(directory, constants.R_OK | constants.X_OK | (input.access === 'read-write' ? constants.W_OK : 0));
      return { id: workspaceId, projectId, name: input.name, status: 'open', management: input.management, requestedDirectory, directory, access: input.access, scope: { root: directory, recursive: true }, directoryIdentity: { device: facts.dev.toString(), inode: facts.ino.toString() } };
    } catch { throw new AorkError('WORKSPACE_DIRECTORY_INVALID', 'Choose an existing absolute server directory with the requested access, or a writable managed directory'); }
  }
  function requireProject(id: string, transaction: import('@aork/sdk/server').SyncTransaction) {
    const project = repository.project(id, transaction);
    if (!project || project.status !== 'open') throw new AorkError('PROJECT_UNAVAILABLE', 'Project is archived or unavailable', 409);
    return project;
  }
  context.durableCommand('workspace.create', {
    version: 1, payload: createWorkspaceSchema, result: workspaceSchema,
    events: { 'workspace.created': { version: 1, payload: workspaceSchema } },
    prepare: payload => prepareWorkspace(payload.projectId, payload.workspace),
    execute(payload, workspace, transaction) {
      requireProject(payload.projectId, transaction); repository.insertWorkspace(transaction, workspace);
      return { result: workspace, events: [{ type: 'workspace.created', version: 1, entityId: workspace.id, payload: workspace }] };
    },
  });
  context.durableCommand('workspace.editProject', {
    version: 1, payload: editProjectSchema, result: projectSchema,
    events: { 'workspace.projectEdited': { version: 1, payload: projectSchema } },
    execute(payload, _prepared, transaction) {
      const project = { ...requireProject(payload.id, transaction), name: payload.name }; repository.updateProject(transaction, project);
      return { result: project, events: [{ type: 'workspace.projectEdited', version: 1, entityId: project.id, payload: project }] };
    },
  });
  context.durableCommand('workspace.archiveProject', {
    version: 1, payload: entityIdSchema, result: projectSchema,
    events: { 'workspace.projectArchived': { version: 1, payload: projectSchema } },
    execute(payload, _prepared, transaction) {
      const existing = repository.project(payload.id, transaction); if (!existing) throw new AorkError('PROJECT_UNAVAILABLE', 'Project is unavailable', 404);
      const project = { ...existing, status: 'archived' as const }; repository.updateProject(transaction, project);
      return { result: project, events: [{ type: 'workspace.projectArchived', version: 1, entityId: project.id, payload: project }] };
    },
  });
  context.durableCommand('workspace.edit', {
    version: 1, payload: editWorkspaceSchema, result: workspaceSchema,
    events: { 'workspace.edited': { version: 1, payload: workspaceSchema } },
    async prepare(payload) {
      const workspace = repository.workspace(payload.id); if (!workspace) throw new AorkError('WORKSPACE_UNAVAILABLE', 'Workspace is unavailable', 404);
      try {
        const resolved = await realpath(workspace.requestedDirectory); const facts = await stat(resolved, { bigint: true });
        if (resolved !== workspace.directory || facts.dev.toString() !== workspace.directoryIdentity.device || facts.ino.toString() !== workspace.directoryIdentity.inode || !facts.isDirectory()) throw new Error('Directory changed');
        await access(resolved, constants.R_OK | constants.X_OK | (payload.access === 'read-write' ? constants.W_OK : 0));
      } catch { throw new AorkError('WORKSPACE_DIRECTORY_INVALID', 'The registered directory changed or no longer permits the requested access'); }
    },
    execute(payload, _prepared, transaction) {
      const workspace = { ...service.requireOpenWorkspace(payload.id, transaction), name: payload.name, access: payload.access }; repository.updateWorkspace(transaction, workspace);
      return { result: workspace, events: [{ type: 'workspace.edited', version: 1, entityId: workspace.id, payload: workspace }] };
    },
  });
  context.durableCommand('workspace.archive', {
    version: 1, payload: entityIdSchema, result: workspaceSchema,
    events: { 'workspace.archived': { version: 1, payload: workspaceSchema } },
    execute(payload, _prepared, transaction) {
      const existing = repository.workspace(payload.id, transaction); if (!existing) throw new AorkError('WORKSPACE_UNAVAILABLE', 'Workspace is unavailable', 404);
      const workspace = { ...existing, status: 'archived' as const }; repository.updateWorkspace(transaction, workspace);
      return { result: workspace, events: [{ type: 'workspace.archived', version: 1, entityId: workspace.id, payload: workspace }] };
    },
  });
  context.durableCommand('workspace.createProject', {
    version: 1, payload: createProjectSchema, result: createProjectResultSchema,
    events: { 'workspace.projectCreated': { version: 1, payload: createProjectResultSchema } },
    async prepare(payload) {
      const projectId = randomUUID();
      return { project: { id: projectId, name: payload.name, status: 'open' as const }, workspace: await prepareWorkspace(projectId, payload.workspace) };
    },
    execute(_payload, prepared, transaction) {
      repository.insertProject(transaction, prepared.project); repository.insertWorkspace(transaction, prepared.workspace);
      return { result: prepared, events: [{ type: 'workspace.projectCreated', version: 1, entityId: prepared.project.id, payload: prepared }] };
    },
  });
}
