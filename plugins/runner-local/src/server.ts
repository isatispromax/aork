import { AorkError } from '@aork/sdk';
import type { OwnerDescriptor, ServerPluginContext } from '@aork/sdk/server';
import { RUNNER_SERVICE } from '@aork/contracts/runner';
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
    spawn(owner, launch) {
      context.requireCapability('process.spawn');
      const verified = context.verifyOwner(owner);
      const selected = verified.serviceOwners[RUNNER_SERVICE];
      if (disposed || [...barriers].some(ids => affected(ids, verified))) throw new AorkError('RUNNER_UNAVAILABLE', 'Local Runner is unavailable for new work', 409);
      if (selected?.pluginId !== context.owner.pluginId || selected.version !== context.owner.version) throw new AorkError('RUNNER_OWNER_INVALID', 'Run owner does not select this Local Runner', 409);
      const handle = managedProcess(launch, confirmed => {
        if (confirmed) processes.delete(handle);
        else uncertain.add(handle);
      });
      processes.set(handle, verified);
      return handle;
    },
  };
  context.provide(RUNNER_SERVICE, runner);
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
