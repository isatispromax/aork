import { randomUUID } from 'node:crypto';
import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, isAbsolute, relative } from 'node:path';
import { AorkError } from '@aork/sdk';
import type { ServerPluginContext } from '@aork/sdk/server';
import { WORKSPACE_SERVICE, browseDirectoryInputSchema, workspaceOverviewSchema, workspaceSchema, createWorkspaceSchema, entityIdSchema, editWorkspaceSchema, workspaceInputSchema } from '@aork/contracts/workspace';
import { z } from 'zod';
import { createFileService, createWriteCoordinator, inspectWorkspaceDirectory } from './files.js';
import { browseDirectory } from './browse.js';
import type { WorkspaceRunAuthority, WorkspaceRunFiles, Workspace, WorkspaceService } from '@aork/contracts/workspace';
import { workspaceRepository } from './persistence/repository.js';
export { persistence } from './persistence/repository.js';

export function activate(context: ServerPluginContext) {
  const repository = workspaceRepository(context.repository);
  const permits=new WeakMap<object,{runId:string;workspaceId:string;owner:import('@aork/sdk/server').OwnerDescriptor;transaction:import('@aork/sdk/server').SyncTransaction}>();
  function requireOpenWorkspace(id: string, transaction?: import('@aork/sdk/server').SyncTransaction) {
    const workspace = repository.workspace(id, transaction);
    if (!workspace || workspace.status !== 'open') throw new AorkError('WORKSPACE_UNAVAILABLE', 'Workspace is archived or unavailable', 409);
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
  const {assertCurrentWrite,active:activeWriter,...writeService}=coordinator;
  const service: WorkspaceService = {
    reserveClaim(tx, owner, runId, workspaceId, usedPluginIds) {
      context.verifyOwner(owner); const workspace=requireOpenWorkspace(workspaceId,tx);assertCurrentWrite(workspace);
      if(workspace.access!=='read-write')throw new AorkError('WORKSPACE_READ_ONLY','A Run requires a writable Workspace',403);
      if(inspectClaims(workspace).state!=='unclaimed')throw new AorkError('WORKSPACE_WRITE_BUSY','An overlapping directory is already held',409);
      repository.insertClaim(tx,{runId,workspaceId,owner:owner.pluginId,hostEpoch:owner.hostEpoch,root:workspace.directory,device:workspace.directoryIdentity.device,inode:workspace.directoryIdentity.inode,usedPluginIds:[...usedPluginIds],state:'held',reason:'Active Run holds this directory'});
      const permit=Object.freeze({}) as import('@aork/contracts/workspace').WorkspaceClaimPermit;permits.set(permit,{runId,workspaceId,owner,transaction:tx});return permit;
    },
    verifyClaim(tx,permit,owner,runId,workspaceId){context.verifyOwner(owner);const binding=permits.get(permit);const claim=repository.claims(tx).find(c=>c.runId===runId);if(!binding||binding.transaction!==tx||binding.owner!==owner||binding.runId!==runId||binding.workspaceId!==workspaceId||!claim||claim.owner!==owner.pluginId||claim.workspaceId!==workspaceId||claim.hostEpoch!==context.owner.hostEpoch||claim.state!=='held')throw new AorkError('CLAIM_ADMISSION_INVALID','Run needs its own current booked Workspace admission',409);assertCurrentWrite(requireOpenWorkspace(workspaceId,tx));},
    releaseClaim(tx,owner,runId){context.verifyOwner(owner);const claim=repository.claims(tx).find(c=>c.runId===runId);if(claim&&activeWriter(claim.root))throw new AorkError('WORKSPACE_WRITER_PENDING','Actual Workspace IO must finish before Claim release',409);if(!claim||claim.owner!==owner.pluginId)throw new AorkError('CLAIM_OWNER_INVALID','Claim belongs to a different execution authority',409);repository.updateClaim(tx,{...claim,state:'released',reason:''});},
    blockClaim(tx,owner,runId,reason){context.verifyOwner(owner);const claim=repository.claims(tx).find(c=>c.runId===runId);if(!claim||claim.owner!==owner.pluginId)throw new AorkError('CLAIM_OWNER_INVALID','Claim belongs to a different execution authority',409);repository.updateClaim(tx,{...claim,state:'blocked',reason});}, getWorkspace: repository.workspace, requireOpenWorkspace, ...writeService, get files() { return files; },
    async inspectDirectory(id) { const workspace = repository.workspace(id); return workspace ? inspectWorkspaceDirectory(workspace) : { status: 'unavailable', reason: 'registration-missing' }; },
  };
  type Authority={run:{runId:string;generation:number;hostEpoch:string};workspaceId:string;runtime:import('@aork/sdk/server').OwnerDescriptor;root:string;device:string;inode:string;closed:boolean};
  const authorities=new WeakMap<object,Authority>();
  const role=(owner:import('@aork/sdk/server').OwnerDescriptor,id:string)=>{context.verifyOwner(owner);const selected=context.owner.serviceOwners[id];if(!selected||selected.pluginId!==owner.pluginId||selected.version!==owner.version)throw new AorkError('WORKSPACE_CALLER_INVALID','Only the actual selected lifecycle owner may use Run file authority',403);};
  function current(authority:WorkspaceRunAuthority){const binding=authorities.get(authority);if(!binding||binding.closed)throw new AorkError('WORKSPACE_AUTHORITY_INVALID','Run file authority is unavailable',403);role(binding.runtime,'aork.runtime.acp@1');const claim=repository.claims().find(claim=>claim.runId===binding.run.runId);const workspace=requireOpenWorkspace(binding.workspaceId);if(binding.run.hostEpoch!==context.owner.hostEpoch||!claim||claim.state!=='held'||claim.hostEpoch!==binding.run.hostEpoch||claim.workspaceId!==binding.workspaceId||claim.root!==binding.root||claim.device!==binding.device||claim.inode!==binding.inode||workspace.directory!==binding.root||workspace.directoryIdentity.device!==binding.device||workspace.directoryIdentity.inode!==binding.inode)throw new AorkError('WORKSPACE_AUTHORITY_INVALID','The exact current Workspace Claim is required',409);for(const other of repository.claims())if(other.runId!==claim.runId&&other.state!=='released'&&overlaps(other.root,claim.root))throw new AorkError('WORKSPACE_WRITE_BUSY','Another Claim overlaps the Run directory',409);return binding;}
  context.provideScoped<WorkspaceRunFiles>('aork.workspace.run-files@1',consumer=>({
    bindRunAuthority(tx,permit,claimOwner,run,workspaceId){role(consumer,'aork.runtime.acp@1');service.verifyClaim(tx,permit,claimOwner,run.runId,workspaceId);if(run.hostEpoch!==context.owner.hostEpoch)throw new AorkError('WORKSPACE_AUTHORITY_INVALID','A current Run is required',409);const workspace=requireOpenWorkspace(workspaceId,tx);const authority=Object.freeze({}) as WorkspaceRunAuthority;authorities.set(authority,{run:{...run},workspaceId,runtime:consumer,root:workspace.directory,device:workspace.directoryIdentity.device,inode:workspace.directoryIdentity.inode,closed:false});return authority;},
    close(authority){const binding=authorities.get(authority);if(!binding||binding.runtime!==consumer)throw new AorkError('WORKSPACE_AUTHORITY_INVALID','Only the issuing Runtime may close authority',403);binding.closed=true;},
    files(authority,signal){role(consumer,'aork.tools@1');const binding=current(authority);const check=()=>{role(consumer,'aork.tools@1');current(authority);if(signal.aborted)throw new AorkError('TOOL_CANCELLED','Tool file access was cancelled',409);};check();const runFiles=createFileService(service,{check,write:(id,operation)=>coordinator.withWritePermission(id,operation,check)});return{preview:async(path,startLine,lines)=>{check();const result=await runFiles.preview(binding.workspaceId,path,startLine,lines);check();return result;},writeText:(path,text,expectedRevision)=>{check();return runFiles.writeText(binding.workspaceId,path,text,expectedRevision);}};
    },
  }));
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
  context.query('workspace.overview', { access: 'authenticated', execute: () => workspaceOverviewSchema.parse({ workspaces: repository.workspaces() }) });
  context.resource('workspace.browseDirectory', { maxBytes: 1024 * 1024, async read(parameters) { const input = parse(browseDirectoryInputSchema, parameters); return json(await browseDirectory(input.path)); } });
  async function prepareWorkspace(input: z.infer<typeof workspaceInputSchema>): Promise<Workspace> {
    const workspaceId = randomUUID();
    try {
      const requestedDirectory = input.directory;
      if (!isAbsolute(requestedDirectory)) throw new Error('Directory must be absolute');
      const directory = await realpath(requestedDirectory); const facts = await stat(directory, { bigint: true });
      if (!facts.isDirectory()) throw new Error('Not a directory');
      await access(directory, constants.R_OK | constants.X_OK | (input.access === 'read-write' ? constants.W_OK : 0));
      return { id: workspaceId, name: input.name, status: 'open', requestedDirectory, directory, access: input.access, scope: { root: directory, recursive: true }, directoryIdentity: { device: facts.dev.toString(), inode: facts.ino.toString() } };
    } catch { throw new AorkError('WORKSPACE_DIRECTORY_INVALID', 'Choose an existing absolute server directory with the requested access'); }
  }
  context.durableCommand('workspace.create', {
    version: 1, payload: createWorkspaceSchema, result: workspaceSchema,
    events: { 'workspace.created': { version: 1, payload: workspaceSchema } },
    prepare: payload => prepareWorkspace(payload.workspace),
    execute(_payload, workspace, transaction) {
      repository.insertWorkspace(transaction, workspace);
      return { result: workspace, events: [{ type: 'workspace.created', version: 1, entityId: workspace.id, payload: workspace }] };
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
}
