import { AorkError } from '@aork/sdk';
import type { OwnerDescriptor, ServerPluginContext } from '@aork/sdk/server';
import { RUNNER_SERVICE, RUNNER_INSPECTION } from '@aork/contracts/runner';
import type { LocalRunner, ManagedProcess } from '@aork/contracts/runner';
import { managedProcess } from './process.js';

export function activate(context: ServerPluginContext) {
  context.requireCapability('process.spawn');
  const processes = new Map<ManagedProcess, OwnerDescriptor>();
  const uncertain = new Set<ManagedProcess>();
  const barriers = new Set<readonly string[]>();
  let disposed = false;
  const affected = (ids: readonly string[], owner: OwnerDescriptor) => ids.includes(context.pluginId) || ids.includes(owner.pluginId);
  const runner: LocalRunner = {
    spawn(owner, launch, work) {
      context.requireCapability('process.spawn');
      const verified = context.verifyOwner(owner);
      const selected = verified.serviceOwners[RUNNER_SERVICE];
      if (disposed || [...barriers].some(ids => affected(ids, verified))) throw new AorkError('RUNNER_UNAVAILABLE', 'Local Runner is unavailable for new work', 409);
      if (selected?.pluginId !== context.owner.pluginId || selected.version !== context.owner.version) throw new AorkError('RUNNER_OWNER_INVALID', 'Run owner does not select this Local Runner', 409);
      const handle = managedProcess(launch, confirmed => {
        if (confirmed) { processes.delete(handle); uncertain.delete(handle); }
        else if (processes.has(handle)) uncertain.add(handle);
      }, work);
      processes.set(handle, verified);
      return handle;
    },
  };
  context.provide(RUNNER_SERVICE, runner);
  context.provideScoped(RUNNER_INSPECTION, consumer => ({
    async inspectGroup(group: number) {
      context.verifyOwner(consumer);
      const selected = context.owner.serviceOwners['aork.runtime.acp@1'];
      if (disposed || consumer.pluginGraphHash !== context.owner.pluginGraphHash || selected?.pluginId !== consumer.pluginId || selected.version !== consumer.version) throw new AorkError('RUNNER_INSPECTION_DENIED', 'Only the selected Runtime may inspect recorded execution', 409);
      if (process.platform === 'win32' || !Number.isSafeInteger(group) || group <= 1 || group > 2147483647) return 'unavailable';
      try { process.kill(-group, 0); return 'present'; }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'absent' : 'unavailable'; }
    },
  }));
  context.lifecycleGuard({ acquireChange(ids) {
    const barrier = [...ids]; barriers.add(barrier);
    const busy = [...processes.values()].some(owner => affected(ids, owner));
    const unknown = [...uncertain].some(handle => affected(ids, processes.get(handle)!));
    return { state: unknown ? 'unknown' : busy ? 'busy' : 'idle', release: () => { barriers.delete(barrier); } };
  } });
  context.effect(() => async () => {
    disposed = true;
    await Promise.all([...processes.keys()].map(handle => handle.stop()));
  });
}
