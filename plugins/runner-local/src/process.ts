import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { AorkError } from '@aork/sdk';
import type { LocalRunner, ManagedProcess, ManagedWorkObserver } from '@aork/contracts/runner';

type Launch = Parameters<LocalRunner['spawn']>[1];
const environmentNames = new Set(['PATH', 'LANG', 'LC_ALL', 'TMPDIR']);
const pollMilliseconds = 20;
const inputGraceMilliseconds = 100;
const terminateMilliseconds = 1000;
const killMilliseconds = 1000;
const jobMilliseconds = 2000;

/** No process.env defaults: Providers must explicitly supply every permitted value. */
function environment(launch: Launch): Record<string, string> {
  if (!launch || typeof launch.executable !== 'string' || !launch.executable || launch.executable.includes('\0') || !Array.isArray(launch.arguments) || launch.arguments.some(argument => typeof argument !== 'string' || argument.includes('\0')) || typeof launch.cwd !== 'string' || !isAbsolute(launch.cwd) || launch.cwd.includes('\0') || !launch.environment || typeof launch.environment !== 'object') {
    throw new AorkError('RUNNER_LAUNCH_INVALID', 'Run launch configuration is invalid');
  }
  const values: Record<string, string> = Object.create(null);
  let bytes = 0;
  for (const [name, value] of Object.entries(launch.environment)) {
    if (!environmentNames.has(name) || typeof value !== 'string' || value.includes('\0')) throw new AorkError('RUNNER_ENVIRONMENT_INVALID', 'Run environment contains an unsupported value');
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (bytes > 32768) throw new AorkError('RUNNER_ENVIRONMENT_INVALID', 'Run environment exceeds the supported size');
    values[name] = value;
  }
  return values;
}

function pause(milliseconds: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, milliseconds)); }

/** Cancellation rejection or non-acknowledgment leaves the associated work uncertain. */
async function cancelJob(cancel: () => void | Promise<void>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(cancel).then(() => true, () => false),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), jobMilliseconds); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

export function managedProcess(launch: Launch, onStop: (confirmed: boolean) => void, work?: ManagedWorkObserver): ManagedProcess {
  if (process.platform === 'win32') throw new AorkError('RUNNER_PLATFORM_UNSUPPORTED', 'Local Runner requires POSIX process groups', 503);
  const env = environment(launch);
  let child: ReturnType<typeof spawn>;
  try { child = spawn(launch.executable, [...launch.arguments], { cwd: launch.cwd, env, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch { throw new AorkError('RUNNER_SPAWN_FAILED', 'Agent process could not be started', 503); }

  // Raw spawn errors and stderr may include arguments, paths or credentials. Never
  // retain, log or surface them; the public failure is a fixed bounded diagnostic.
  let leaderExited = false;
  let settleExit!: () => void;
  const exited = new Promise<void>(resolve => { settleExit = resolve; });
  const finishLeader = () => { leaderExited = true; settleExit(); };
  child.on('error', finishLeader);
  child.once('exit', finishLeader);
  child.stdin?.on('error', () => {});
  child.stdout?.on('error', () => {});
  child.stderr?.on('error', () => {});
  child.stderr?.resume();
  const pid = child.pid;
  if (!pid || !child.stdin || !child.stdout) throw new AorkError('RUNNER_SPAWN_FAILED', 'Agent process could not be started', 503);

  let groupAbsent = false;
  let stopping: Promise<{ confirmed: boolean }> | undefined;
  const jobs = new Set<{ cancel: () => void | Promise<void>; settled: boolean }>();
  const settledWork = () => { if ([...jobs].every(job => job.settled)) work?.changed('settled'); };
  const inspectStopped = async () => { const confirmed = leaderExited && absent() && [...jobs].every(job => job.settled); if (confirmed) onStop(true); return { confirmed }; };
  // Once absence is observed, never signal this numeric group again: its ID can
  // later be reused. A live detached group remains owned after its leader exits.
  function absent(): boolean {
    if (groupAbsent) return true;
    try { process.kill(-pid!, 0); return false; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') groupAbsent = true;
      return groupAbsent;
    }
  }
  function signal(signalName: NodeJS.Signals): void {
    if (absent()) return;
    try { process.kill(-pid!, signalName); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') groupAbsent = true; }
  }
  async function waitForGroup(milliseconds: number): Promise<boolean> {
    const deadline = performance.now() + milliseconds;
    do {
      if (leaderExited && absent()) return true;
      await pause(Math.min(pollMilliseconds, Math.max(0, deadline - performance.now())));
    } while (performance.now() < deadline);
    return leaderExited && absent();
  }
  // POSIX group supervision covers children that remain in the managed group.
  // It cannot prove termination of descendants that deliberately escape it.
  const handle: ManagedProcess = {
    stdout: child.stdout,
    stdin: child.stdin,
    exited,
    identity: Object.freeze({ pid, group: pid }),
    registerJob(cancel) {
      if (stopping) throw new AorkError('RUNNER_STOPPING', 'Run is stopping and cannot accept new work', 409);
      if (typeof cancel !== 'function') throw new AorkError('RUNNER_JOB_INVALID', 'Run work must provide cancellation');
      work?.changed('unsettled');
      const job = { cancel, settled: false }; jobs.add(job);
      return () => { job.settled = true; jobs.delete(job); settledWork(); };
    },
    inspectStopped,
    stop() {
      if (stopping) return stopping;
      // Close admission synchronously; jobs registered during cancellation must
      // not evade the snapshot which determines confirmation.
      let settleStop!: (result: { confirmed: boolean }) => void;
      stopping = new Promise(resolve => { settleStop = resolve; });
      const cancellations = [...jobs].map(job => cancelJob(async () => { await job.cancel(); job.settled = true; jobs.delete(job); settledWork(); }));
      void (async () => {
        try {
          try { child.stdin!.end(); } catch { /* Escalation still checks the actual group. */ }
          let terminated = await waitForGroup(inputGraceMilliseconds);
          if (!terminated) { signal('SIGTERM'); terminated = await waitForGroup(terminateMilliseconds); }
          if (!terminated) { signal('SIGKILL'); terminated = await waitForGroup(killMilliseconds); }
          const acknowledged = (await Promise.all(cancellations)).every(Boolean);
          const confirmed = terminated && acknowledged;
          onStop(confirmed);
          settleStop({ confirmed });
        } catch { onStop(false); settleStop({ confirmed: false }); }
      })();
      return stopping;
    },
  };
  return Object.freeze(handle);
}
