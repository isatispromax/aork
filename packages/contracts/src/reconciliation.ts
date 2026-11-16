import { z } from 'zod';
import type { SyncTransaction } from '@aork/sdk/server';

export const RUNTIME_RECONCILIATION = 'aork.runtime.reconciliation@1';
export const SESSION_RECONCILIATION = 'sessions.reconciliation';
export const recheckRunSchema = z.object({ runId: z.uuid() }).strict();
/** Fixed diagnostics only. Neither a browser receipt nor a Run ID grants release authority. */
export const reconciliationSchema = z.object({
  runId: z.uuid(), generation: z.number().int().positive(),
  status: z.enum(['blocked', 'verified-stopped']),
  reason: z.enum(['managed-stop-confirmed', 'never-started', 'covered-group-absent', 'group-present', 'identity-missing', 'inspection-unavailable', 'coverage-incomplete', 'participant-unavailable', 'work-unsettled', 'authority-unavailable']),
  observedAt: z.iso.datetime(), coverage: z.enum(['complete', 'unknown']),
  actions: z.array(z.enum(['check-again', 'inspect-locally', 'restore-authority'])).max(3),
}).strict();
export type Reconciliation = z.infer<typeof reconciliationSchema>;
declare const preparationBrand: unique symbol;
/** Server-only one-use capability. Contents cannot be serialized or supplied by a caller. */
export interface ReconciliationPreparation { readonly [preparationBrand]: true }
export interface RuntimeReconciliation {
  prepare(runId: string, principal: string): Promise<ReconciliationPreparation>;
  /** Revalidates the bound actual caller, graph and unchanged original operation in this TX. */
  apply(transaction: SyncTransaction, prepared: ReconciliationPreparation): Reconciliation;
}
export const reconciliationSnapshotSchema = z.object({ reconciliation: reconciliationSchema.nullable() }).strict();

/** Optional pull service below Runtime. Its provider binds methods to the actual
 * selected Runtime consumer with provideScoped; metadata is never authority. */
export const EXECUTION_WRITERS = 'aork.execution.writers@1';
export const executionWriterSnapshotSchema = z.object({
  version:z.literal(1),owner:z.object({pluginId:z.string().regex(/^[a-z][a-z0-9.-]*$/).max(120),version:z.string().min(1).max(100)}).strict(),
  revision:z.string().min(1).max(120),coverage:z.enum(['complete','unknown']),
}).strict();
export type ExecutionWriterSnapshot = z.infer<typeof executionWriterSnapshotSchema>;
export interface ExecutionRun {runId:string;generation:number;hostEpoch:string}
declare const writerPreparationBrand:unique symbol;
export interface ExecutionWriterPreparation {readonly [writerPreparationBrand]:true}
export interface ExecutionWriters {
  /** Capture own bounded owner/version/coverage in the Run admission TX before effects. */
  capture(transaction:SyncTransaction,run:ExecutionRun):ExecutionWriterSnapshot;
  /** Read-only external observation; no SQLite transaction spans this await. */
  prepare(run:ExecutionRun,captured:ExecutionWriterSnapshot):Promise<ExecutionWriterPreparation>;
  /** Revalidate own unchanged state and authority, revoke old grants and classify
   * in the shared TX. Abort delivery or elapsed time never proves stopped IO. */
  apply(transaction:SyncTransaction,prepared:ExecutionWriterPreparation):'stopped'|'unknown';
}
