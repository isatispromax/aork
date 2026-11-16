import { AorkError } from '@aork/sdk';
import type { ServerPluginContext, SyncTransaction } from '@aork/sdk/server';
import { RUNTIME_RECONCILIATION, reconciliationSchema, type Reconciliation, type ReconciliationPreparation, type RuntimeReconciliation } from '@aork/contracts/reconciliation';
import type { RecordedProcessInspection, ManagedProcess } from '@aork/contracts/runner';
import type { operationRepository } from './persistence/repository.js';

type Repository = ReturnType<typeof operationRepository>;
/** No numeric process identity is ever converted to a live capability or signalled here. */
export function provideReconciliation(context: ServerPluginContext, repository: Repository, inspection: () => RecordedProcessInspection, liveProcess: (runId: string) => ManagedProcess | undefined) {
  context.provideScoped<RuntimeReconciliation>(RUNTIME_RECONCILIATION, consumer => {
    const preparations = new WeakMap<object, { record: string; runId: string; principal: string; graph: string; diagnostic: Reconciliation }>();
    function authority() {
      context.verifyOwner(consumer);
      const selected = context.owner.serviceOwners['aork.sessions@1'];
      if (consumer.hostEpoch !== context.owner.hostEpoch || consumer.pluginGraphHash !== context.owner.pluginGraphHash || selected?.pluginId !== consumer.pluginId || selected.version !== consumer.version) throw new AorkError('RECONCILIATION_OWNER_INVALID', 'Only the current selected Session lifecycle owner may reconcile execution', 409);
    }
    function owned(runId: string, principal: string) {
      const operation = repository.get(runId);
      if (!operation || operation.launch.principal !== principal || operation.launch.owner.pluginId !== consumer.pluginId || operation.launch.owner.version !== consumer.version) throw new AorkError('RUN_UNAVAILABLE', 'Run is unavailable', 404);
      return operation;
    }
    return Object.freeze({
      async prepare(runId: string, principal: string) {
        authority(); const op = owned(runId, principal); const record = JSON.stringify(op); const graph = context.owner.pluginGraphHash;
        if (op.state !== 'unknown' && op.state !== 'stopped') throw new AorkError('RUN_RECONCILIATION_NOT_REQUIRED', 'Only stopped or uncertain execution can be checked', 409);
        let reason: Reconciliation['reason'] = 'coverage-incomplete'; let verified = false;
        const complete = op.writers?.version === 1 && op.writers.policy === 'posix-group' && op.writers.runner?.pluginId === context.owner.serviceOwners['aork.runner.local@1']?.pluginId && op.writers.runner?.version === context.owner.serviceOwners['aork.runner.local@1']?.version;
        if (op.state === 'stopped') { reason = 'managed-stop-confirmed'; verified = true; }
        else if (complete) {
          if (op.writers!.registeredWork === 'unsettled') reason = 'work-unsettled';
          else if (op.interruption?.state === 'pending' && !op.interruption.attempt && !op.processIdentity) { reason = 'never-started'; verified = true; }
          else if (op.launch.run.hostEpoch === context.owner.hostEpoch && liveProcess(runId)) {
            verified = (await liveProcess(runId)!.inspectStopped()).confirmed;
            reason = verified ? 'managed-stop-confirmed' : 'work-unsettled';
          } else if (!op.processIdentity || !Number.isSafeInteger(op.processIdentity.pid) || op.processIdentity.pid <= 1 || op.processIdentity.pid !== op.processIdentity.group) reason = 'identity-missing';
          else {
            let observation: Awaited<ReturnType<RecordedProcessInspection['inspectGroup']>> = 'unavailable';
            try { observation = await inspection().inspectGroup(op.processIdentity.group); } catch { /* Fixed diagnostic; OS errors never leave this owner. */ }
            verified = observation === 'absent'; reason = observation === 'absent' ? 'covered-group-absent' : observation === 'present' ? 'group-present' : 'inspection-unavailable';
          }
        }
        const diagnostic = reconciliationSchema.parse({ runId, generation: op.launch.run.generation, status: verified ? 'verified-stopped' : 'blocked', reason, observedAt: new Date().toISOString(), coverage: complete ? 'complete' : 'unknown', actions: verified ? [] : ['check-again', ...(reason === 'coverage-incomplete' || reason === 'identity-missing' ? ['restore-authority'] : ['inspect-locally'])] });
        const token = Object.freeze({}) as ReconciliationPreparation; preparations.set(token, { record, runId, principal, graph, diagnostic }); return token;
      },
      apply(tx: SyncTransaction, token: ReconciliationPreparation) {
        authority(); const prepared = preparations.get(token); preparations.delete(token);
        if (!prepared || prepared.graph !== context.owner.pluginGraphHash) throw new AorkError('RECONCILIATION_PREPARATION_STALE', 'Request a fresh execution check', 409);
        const op = repository.get(prepared.runId, tx);
        if (!op || JSON.stringify(op) !== prepared.record || op.launch.principal !== prepared.principal || op.launch.owner.pluginId !== consumer.pluginId || op.launch.owner.version !== consumer.version) throw new AorkError('RECONCILIATION_PREPARATION_STALE', 'Execution changed during the check; request a fresh check', 409);
        if (prepared.diagnostic.status === 'verified-stopped' && op.state !== 'stopped') repository.update(tx, { ...op, state: 'stopped', launch: { ...op.launch, run: { ...op.launch.run, state: 'stopped' } } });
        return prepared.diagnostic;
      },
    });
  });
}
