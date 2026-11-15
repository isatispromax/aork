import { z } from 'zod';
import {runToolSummarySchema} from './tools.js';
import type {RunToolSnapshot} from './tools.js';
import type { FactSource, OwnerDescriptor, SyncTransaction } from '@aork/sdk/server';
import type { AgentLaunchSnapshot } from './agent.js';
import type { Workspace, WorkspaceClaimPermit } from './workspace.js';
import { turnStateSchema, toolDisplaySchema, turnSchema } from './turn.js';
import { permissionFactSchema, type PermissionInteraction } from './interaction.js';
export const ACP_RUNTIME = 'aork.runtime.acp@1';
export const runStateSchema = z.enum(['starting','ready','stopping','stopped','unknown']);
export const runSchema = z.object({
  runId:z.uuid(), sessionId:z.uuid(), generation:z.number().int().positive(), hostEpoch:z.uuid(), state:runStateSchema,
  directory:z.string(), profileRevision:z.number().int().positive(), providerDefinitionVersion:z.string(), detectedVersion:z.string(),
  protocolVersion:z.number().optional(), agentVersion:z.string().max(100).optional(), agentName:z.string().max(100).optional(), nativeSessionId:z.string().max(500).optional(),
  stateReference:z.string().optional(), loadSession:z.boolean().optional(), reason:z.string().max(500).optional(),
  processIdentity:z.object({pid:z.number().int().positive(),group:z.number().int().positive()}).strict().optional(),
  runtime:z.object({nodeVersion:z.string(),acpSdkVersion:z.string(),platform:z.string(),osRelease:z.string()}).strict(),
  environment:z.object({inherited:z.literal(false),names:z.array(z.string())}).strict(),
  pluginGraphHash:z.string(), usedPluginIds:z.array(z.string()), tools:runToolSummarySchema.optional(),
}).strict();
export type RuntimeRun = z.infer<typeof runSchema>;
export const runtimeFactSchema = z.object({runId:z.uuid(),generation:z.number().int().positive(),hostEpoch:z.uuid(),state:runStateSchema,details:runSchema.partial().optional()}).strict();
export type RuntimeFact = z.infer<typeof runtimeFactSchema>;
const turnFactBase=z.object({runId:z.uuid(),generation:z.number().int().positive(),hostEpoch:z.uuid(),turnId:z.uuid()});
export const runtimeTurnFactSchema=z.discriminatedUnion('kind',[
  turnFactBase.extend({kind:z.literal('state'),state:turnStateSchema,dispatchPaused:z.boolean().optional(),stopReason:z.string().max(100).optional(),reason:z.string().max(500).optional()}).strict(),
  turnFactBase.extend({kind:z.literal('text'),sequence:z.number().int().positive(),text:z.string().max(4000),messageId:z.string().max(200).optional()}).strict(),
  turnFactBase.extend({kind:z.literal('tool'),tool:toolDisplaySchema}).strict(),
  turnFactBase.extend({kind:z.literal('usage'),usage:turnSchema.shape.usage.unwrap()}).strict(),
]);
export type RuntimeTurnFact=z.infer<typeof runtimeTurnFactSchema>;
export interface RunLaunch {
  run:RuntimeRun; toolSnapshot?:RunToolSnapshot; principal:string; claim:WorkspaceClaimPermit; owner:OwnerDescriptor; workspace:Workspace; agent:AgentLaunchSnapshot;
}
export interface AcpRuntime {
  readonly facts:FactSource<RuntimeFact>;
  readonly turnFacts:FactSource<RuntimeTurnFact>;
  readonly permissionFacts:FactSource<z.infer<typeof permissionFactSchema>>;
  readonly versions:RuntimeRun['runtime'];
  readonly environmentNames:readonly string[];
  withAdmission<T>(usedPluginIds:readonly string[],operation:()=>Promise<T>):Promise<T>;
  acceptStart(transaction:SyncTransaction,launch:RunLaunch):void;
  acceptStop(transaction:SyncTransaction,owner:OwnerDescriptor,runId:string,generation:number):void;
  acceptPrompt(transaction:SyncTransaction,owner:OwnerDescriptor,input:{turnId:string;runId:string;generation:number;text:string}):void;
  acceptCancel(transaction:SyncTransaction,owner:OwnerDescriptor,turnId:string):void;
  /** Commits only a durable intent; live-channel validation and ACP I/O follow outside the transaction. */
  acceptResponse(transaction:SyncTransaction,owner:OwnerDescriptor,principal:string,interaction:PermissionInteraction,optionId:string):void;
  /** Explicit shutdown joins initialization and group cleanup; no lifetime HTTP lease. */
  shutdown():Promise<void>;
}
