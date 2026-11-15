import type { OwnerRepository, RepositoryDeclaration, SyncTransaction } from '@aork/sdk/server';
import type { PermissionInteraction } from '@aork/contracts/interaction';
import type { StructuredInput, InputSubmission } from '@aork/contracts/structured-input';
import type { RunLaunch } from '@aork/contracts/runtime';
export interface Operation { launch:Omit<RunLaunch,'claim'>; state:'pending'|'attempting'|'ready'|'stopping'|'stopped'|'unknown'; attempt?:'spawn'|'initialize'|'session.new'|'stop'; stopRequested:boolean; processIdentity?:Readonly<{pid:number;group:number}> }
export interface PromptOperation {turnId:string;runId:string;generation:number;text:string;hostEpoch:string;state:'pending'|'attempting'|'running'|'terminal';progress:boolean;cancelRequested:boolean}
export interface ResponseOperation {interaction:PermissionInteraction|StructuredInput;optionId?:string;submission?:InputSubmission;state:'pending'|'attempting'|'terminal'}
export const persistence:RepositoryDeclaration={namespace:'plugin_runtime_hacp__',migrations:[{version:1,statements:['CREATE TABLE plugin_runtime_hacp__operations (run_id TEXT PRIMARY KEY, record TEXT NOT NULL)']},{version:2,statements:['CREATE TABLE plugin_runtime_hacp__prompts (turn_id TEXT PRIMARY KEY, record TEXT NOT NULL)']},{version:3,statements:['CREATE TABLE plugin_runtime_hacp__responses (interaction_id TEXT PRIMARY KEY, record TEXT NOT NULL)']}],statements:{
  responses:{sql:'SELECT record FROM plugin_runtime_hacp__responses ORDER BY rowid',mode:'read'},
  putResponse:{sql:'INSERT OR REPLACE INTO plugin_runtime_hacp__responses (interaction_id,record) VALUES (?,?)',mode:'write'},
  prompts:{sql:'SELECT record FROM plugin_runtime_hacp__prompts ORDER BY rowid',mode:'read'},
  prompt:{sql:'SELECT record FROM plugin_runtime_hacp__prompts WHERE turn_id=?',mode:'read'},
  insertPrompt:{sql:'INSERT INTO plugin_runtime_hacp__prompts (turn_id,record) VALUES (?,?)',mode:'write'},
  updatePrompt:{sql:'UPDATE plugin_runtime_hacp__prompts SET record=? WHERE turn_id=?',mode:'write'},
  active:{sql:"SELECT record FROM plugin_runtime_hacp__operations WHERE json_extract(record, '$.state') NOT IN ('stopped','unknown') ORDER BY rowid",mode:'read'},
  list:{sql:'SELECT record FROM plugin_runtime_hacp__operations ORDER BY rowid',mode:'read'},
  get:{sql:'SELECT record FROM plugin_runtime_hacp__operations WHERE run_id=?',mode:'read'},
  insert:{sql:'INSERT INTO plugin_runtime_hacp__operations (run_id,record) VALUES (?,?)',mode:'write'},
  update:{sql:'UPDATE plugin_runtime_hacp__operations SET record=? WHERE run_id=?',mode:'write'},
}};
export function operationRepository(binding:OwnerRepository){return {
  responses:(tx?:SyncTransaction)=>binding.all<{record:string}>('responses',[],tx).map(row=>JSON.parse(row.record) as ResponseOperation),
  putResponse(tx:SyncTransaction,record:ResponseOperation){binding.run(tx,'putResponse',[record.interaction.id,JSON.stringify(record)]);},
  prompts:(tx?:SyncTransaction)=>binding.all<{record:string}>('prompts',[],tx).map(row=>JSON.parse(row.record) as PromptOperation),
  prompt:(id:string,tx?:SyncTransaction)=>{const row=binding.all<{record:string}>('prompt',[id],tx)[0];return row?JSON.parse(row.record) as PromptOperation:undefined;},
  insertPrompt(tx:SyncTransaction,record:PromptOperation){binding.run(tx,'insertPrompt',[record.turnId,JSON.stringify(record)]);},
  updatePrompt(tx:SyncTransaction,record:PromptOperation){binding.run(tx,'updatePrompt',[JSON.stringify(record),record.turnId]);},
  active:(tx?:SyncTransaction)=>binding.all<{record:string}>('active',[],tx).map(row=>JSON.parse(row.record) as Operation),
  list:(tx?:SyncTransaction)=>binding.all<{record:string}>('list',[],tx).map(row=>JSON.parse(row.record) as Operation),
  get:(runId:string,tx?:SyncTransaction)=>{const row=binding.all<{record:string}>('get',[runId],tx)[0];return row?JSON.parse(row.record) as Operation:undefined;},
  insert(tx:SyncTransaction,record:Operation){binding.run(tx,'insert',[record.launch.run.runId,JSON.stringify(record)]);},
  update(tx:SyncTransaction,record:Operation){binding.run(tx,'update',[JSON.stringify(record),record.launch.run.runId]);},
};}
