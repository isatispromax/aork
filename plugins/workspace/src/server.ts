import { randomUUID } from 'node:crypto';
import { access, mkdir, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { AorkError } from '@aork/sdk';
import type { ServerPluginContext } from '@aork/sdk/server';
import { WORKSPACE_SERVICE, createProjectSchema, createProjectResultSchema, workspaceOverviewSchema, workspaceSchema, projectSchema, createWorkspaceSchema, editProjectSchema, entityIdSchema, editWorkspaceSchema, workspaceInputSchema } from '@aork/contracts/workspace';
import { z } from 'zod';
import { basename } from 'node:path';
import { createFileService, createWriteCoordinator, inspectWorkspaceDirectory } from './files.js';
import type { Workspace, WorkspaceService } from '@aork/contracts/workspace';
import { workspaceRepository } from './persistence/repository.js';
export { persistence } from './persistence/repository.js';

export function activate(context: ServerPluginContext) {
  const repository = workspaceRepository(context.repository);
  const permits=new WeakMap<object,{runId:string;workspaceId:string;owner:import('@aork/sdk/server').OwnerDescriptor;transaction:import('@aork/sdk/server').SyncTransaction}>();
  function requireOpenWorkspace(id: string, transaction?: import('@aork/sdk/server').SyncTransaction) {
    const workspace = repository.workspace(id, transaction);
    if (!workspace || workspace.status !== 'open' || repository.project(workspace.projectId, transaction)?.status !== 'open') throw new AorkError('WORKSPACE_UNAVAILABLE', 'Workspace or its Project is archived or unavailable', 409);
    return workspace;
  }
  const overlaps = (a:string,b:string) => {const x=relative(a,b),y=relative(b,a);return !x||(!x.startsWith('../')&&x!=='..'&&!isAbsolute(x))||(!y.startsWith('../')&&y!=='..'&&!isAbsolute(y));};
  const inspectClaims = (workspace: Workspace): import('@aork/contracts/workspace').WorkspaceWriterState => {
    const claim=repository.claims().find(claim=>claim.state!=='released'&&((claim.device===workspace.directoryIdentity.device&&claim.inode===workspace.directoryIdentity.inode)||overlaps(claim.root,workspace.directory)));
    return claim?{state:claim.state==='blocked'?'unknown':'blocked',reason:claim.reason||'This directory is held by an active Run'}:{state:'unclaimed'};
  };
  context.transactions.run(tx=>{for(const claim of repository.claims(tx))if(claim.state!=='released'&&claim.hostEpoch!==context.owner.hostEpoch)repository.updateClaim(tx,{...claim,state:'blocked',reason:'Previous Host execution cannot be verified; local maintenance is required. No old PID will be signalled.'});});
  context.lifecycleGuard({acquireChange(affected){const claims=repository.claims().filter(c=>c.state!=='released'&&c.usedPluginIds.some(id=>affected.includes(id)));return {state:claims.some(c=>c.state==='blocked')?'unknown':claims.length?'busy':'idle',release(){}};}});
  const coordinator = createWriteCoordinator(id => requireOpenWorkspace(id), inspectClaims);
  const {assertCurrentWrite,...writeService}=coordinator;
  const service: WorkspaceService = {
    requireOpenProject(id,tx){const project=repository.project(id,tx);if(!project||project.status!=='open')throw new AorkError('PROJECT_UNAVAILABLE','Project is archived or unavailable',409);return project;},
    reserveClaim(tx, owner, runId, workspaceId, usedPluginIds) {
      context.verifyOwner(owner); const workspace=requireOpenWorkspace(workspaceId,tx);assertCurrentWrite(workspace);
      if(workspace.access!=='read-write')throw new AorkError('WORKSPACE_READ_ONLY','A Run requires a writable Workspace',403);
      if(inspectClaims(workspace).state!=='unclaimed')throw new AorkError('WORKSPACE_WRITE_BUSY','An overlapping directory is already held',409);
      repository.insertClaim(tx,{runId,workspaceId,owner:owner.pluginId,hostEpoch:owner.hostEpoch,root:workspace.directory,device:workspace.directoryIdentity.device,inode:workspace.directoryIdentity.inode,usedPluginIds:[...usedPluginIds],state:'held',reason:'Active Run holds this directory'});
      const permit=Object.freeze({}) as import('@aork/contracts/workspace').WorkspaceClaimPermit;permits.set(permit,{runId,workspaceId,owner,transaction:tx});return permit;
    },
    verifyClaim(tx,permit,owner,runId,workspaceId){context.verifyOwner(owner);const binding=permits.get(permit);const claim=repository.claims(tx).find(c=>c.runId===runId);if(!binding||binding.transaction!==tx||binding.owner!==owner||binding.runId!==runId||binding.workspaceId!==workspaceId||!claim||claim.owner!==owner.pluginId||claim.workspaceId!==workspaceId||claim.hostEpoch!==context.owner.hostEpoch||claim.state!=='held')throw new AorkError('CLAIM_ADMISSION_INVALID','Run needs its own current booked Workspace admission',409);assertCurrentWrite(requireOpenWorkspace(workspaceId,tx));},
    releaseClaim(tx,owner,runId){context.verifyOwner(owner);const claim=repository.claims(tx).find(c=>c.runId===runId);if(!claim||claim.owner!==owner.pluginId)throw new AorkError('CLAIM_OWNER_INVALID','Claim belongs to a different execution authority',409);repository.updateClaim(tx,{...claim,state:'released',reason:''});},
    blockClaim(tx,owner,runId,reason){context.verifyOwner(owner);const claim=repository.claims(tx).find(c=>c.runId===runId);if(!claim||claim.owner!==owner.pluginId)throw new AorkError('CLAIM_OWNER_INVALID','Claim belongs to a different execution authority',409);repository.updateClaim(tx,{...claim,state:'blocked',reason});}, getWorkspace: repository.workspace, requireOpenWorkspace, ...writeService, get files() { return files; },
    async inspectDirectory(id) { const workspace = repository.workspace(id); return workspace ? inspectWorkspaceDirectory(workspace) : { status: 'unavailable', reason: 'registration-missing' }; },
  };
  const files = createFileService(service);
  const json = (value: unknown) => ({ bytes: Buffer.from(JSON.stringify(value)), mediaType: 'application/json' as const });
  function parse<T>(schema: z.ZodType<T>, input: unknown): T { const result = schema.safeParse(input); if (!result.success) throw new AorkError('WORKSPACE_FILE_INPUT_INVALID', 'File parameters are invalid'); return result.data; }
  const fileInput = z.object({ workspaceId: z.uuid(), path: z.string().max(4096) }).strict();
  const previewInput = fileInput.extend({ startLine: z.coerce.number().int().positive().default(1), lines: z.coerce.number().int().min(1).max(500).default(200) });
  context.resource('workspace.files', { maxBytes: 1024 * 1024, async read(parameters) { const input = parse(fileInput, parameters); return json(await files.list(input.workspaceId, input.path)); } });
  context.resource('workspace.search', { maxBytes: 1024 * 1024, async read(parameters) { const input = parse(z.object({ workspaceId: z.uuid(), query: z.string().min(1).max(120) }).strict(), parameters); return json(await files.search(input.workspaceId, input.query)); } });
  context.resource('workspace.preview', { maxBytes: 2 * 1024 * 1024, async read(parameters) { const input = parse(previewInput, parameters); return json(await files.preview(input.workspaceId, input.path, input.startLine, input.lines)); } });
  context.resource('workspace.file', { maxBytes: 8 * 1024 * 1024,
    async read(parameters) { const input = parse(fileInput, parameters); return { bytes: await files.download(input.workspaceId, input.path), mediaType: 'application/octet-stream', filename: basename(input.path) }; },
    async write(parameters, bytes) { const input = parse(fileInput, parameters); return json(await files.upload(input.workspaceId, input.path, bytes)); },
  });
  context.resource('workspace.text', { maxBytes: 256 * 1024,
    async write(parameters, bytes) {
      const input = parse(fileInput.extend({ expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).optional() }), parameters);
      let text: string; try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new AorkError('WORKSPACE_BINARY_FILE', 'Text editing requires UTF-8 text', 415); }
      return json(await files.writeText(input.workspaceId, input.path, text, input.expectedRevision));
    },
  });
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
