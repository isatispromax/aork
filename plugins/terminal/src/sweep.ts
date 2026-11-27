/** What lists the processes on a terminal, as pure logic. `ps -axo pid=,tty=` prints one process
 * per line as a pid and the name of its controlling terminal without `/dev/` — `ttys003` — or
 * `??` for none. This macOS reports every process's session id as 0, so the members of a
 * terminal's session are counted by the terminal they share instead. */

/** The pids whose controlling terminal is `tty`, less the ones named in `exclude`. */
export function pidsOnTty(listing: string, tty: string, exclude: readonly number[] = []): number[] {
  const device = tty.replace(/^\/dev\//, '');
  const pids: number[] = [];
  for (const line of listing.split('\n')) {
    const [pid, terminal] = line.trim().split(/\s+/);
    if (!pid || terminal !== device || !/^[1-9][0-9]*$/.test(pid)) continue;
    const value = Number(pid);
    if (!exclude.includes(value)) pids.push(value);
  }
  return pids;
}

/** The command that prints the listing `pidsOnTty` reads. */
export const PS_TTY_LISTING = ['/bin/ps', ['-axo', 'pid=,tty=']] as const;
