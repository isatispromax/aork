import {z} from 'zod';
import type {FactSource} from '@aork/sdk/server';
import type {AgentLaunchSnapshot} from './agent.js';
export const SESSION_RECOVERY='aork.sessions.recovery@1';
export const SESSION_NATIVE_HISTORY='aork.sessions.native-history@1';
export const recoverNativeSchema=z.object({sessionId:z.uuid()}).strict();
/** Visible native display only. No raw tool arguments/results, metadata, thought or executable authority. */
export const nativeHistoryEntrySchema=z.object({id:z.string().max(220),role:z.enum(['user','agent','tool']),text:z.string().max(4000),messageId:z.string().min(1).max(200).optional()}).strict();
export const nativeHistoryProjectionSchema=z.object({sessionId:z.uuid(),generation:z.uuid(),sourceRunId:z.uuid(),entries:z.array(nativeHistoryEntrySchema).max(2000)}).strict();
export const nativeHistoryPageSchema=nativeHistoryProjectionSchema.omit({entries:true}).extend({generation:z.uuid().nullable(),sourceRunId:z.uuid().nullable(),entries:z.array(nativeHistoryEntrySchema).max(25),next:z.number().int().nonnegative().nullable()}).strict();
export const nativeHistoryQuerySchema=z.object({sessionId:z.uuid(),after:z.coerce.number().int().min(0).max(2000).default(0),generation:z.uuid().optional()}).strict();
export const nativeHistoryFactSchema=z.discriminatedUnion('kind',[nativeHistoryProjectionSchema.omit({entries:true}).extend({kind:z.literal('entry'),sequence:z.number().int().nonnegative(),entry:nativeHistoryEntrySchema}).strict(),nativeHistoryProjectionSchema.omit({entries:true}).extend({kind:z.literal('complete'),count:z.number().int().min(0).max(2000)}).strict()]);
export const nativeHistoryChangedSchema=nativeHistoryProjectionSchema.omit({entries:true});
export type NativeHistoryFact=z.infer<typeof nativeHistoryFactSchema>;
export type NativeHistoryProjection=z.infer<typeof nativeHistoryProjectionSchema>;
export type NativeHistoryEntry=z.infer<typeof nativeHistoryEntrySchema>;
export type NativeHistoryPage=z.infer<typeof nativeHistoryPageSchema>;
/** Opaque one-use owner preparation, never serialized. */
export interface NativeRecoveryPreparation {readonly __nativeRecoveryPreparation:unique symbol}
export interface NativeRecoveryRuntime {
 readonly historyFacts:FactSource<NativeHistoryFact>;
 prepareRecovery(sourceRunId:string,principal:string,agent:AgentLaunchSnapshot):Promise<NativeRecoveryPreparation>;
}
