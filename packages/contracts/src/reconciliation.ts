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
