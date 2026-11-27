/** One terminal's processes: a login shell on a fresh pseudo-terminal, under a supervisor that
 * ends everything the shell left behind. macOS, with its own tools only. The shape was verified
 * on this platform before it was written down here; the reasons it has this shape:
 *
 * - macOS `script` refuses a socket as its stdin and Node hands children sockets, so stdin is
 *   forwarded to it through a pipe by `cat`. Node's own child is `script` still — the outer shell
 *   execs into it — so its exit is the shell's.
 * - The supervisor is not an interactive shell, so it has no job control: a command it puts in
 *   the background reads `/dev/null`. The login shell is therefore given the terminal to read.
 * - It ignores its signals with `trap ':'`, not `trap ''`: an ignored signal would be inherited
 *   by the login shell.
 * - The supervisor sweeps while it still holds the terminal: once it exits, everything else on
 *   the terminal loses it at once and can no longer be found by it.
 * - Node 24 has no `fcntl`, so the terminal is resized through `stty`. */
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { MarkScanner, type TerminalMarks } from './markers.js';
import { PS_TTY_LISTING, pidsOnTty } from './sweep.js';

/** `$0` carries the supervisor, so its quoting is never in question; it is replaced by nothing. */
const LAUNCH = 'exec /usr/bin/script -F -q /dev/null /bin/sh -c "$0" aork-terminal < <(cat)';
/** The supervisor: session leader on the terminal, and the parent of the login shell. */
const SUPERVISOR = [
  "trap ':' INT QUIT TERM TSTP TTIN TTOU",
  'TTY=$(tty) || exit 1',
  // The size asked at the start is set before the shell can see the terminal, so nothing the shell
  // reads while starting finds a terminal of no size.
  '[ -z "$AORK_ROWS" ] || stty -f "$TTY" rows "$AORK_ROWS" cols "$AORK_COLS" 2>/dev/null',
  'printf \'\\033]7777;%s;%s\\007\' "$TTY" "$$"',
  '"$AORK_SHELL" -l < "$TTY" &',
  'child=$!',
  'printf \'\\033]7778;%s\\007\' "$child"',
  'wait "$child"; status=$?',
  'members() { ps -axo pid=,tty= | awk -v t="${TTY#/dev/}" -v me="$$" \'$2 == t && $1 != me { print $1 }\'; }',
  'for pid in $(members); do kill -TERM "$pid" 2>/dev/null; done',
  'i=0; while [ "$i" -lt 4 ] && [ -n "$(members)" ]; do sleep 0.1; i=$((i + 1)); done',
  'for pid in $(members); do kill -KILL "$pid" 2>/dev/null; done',
  'exit "$status"',
].join('\n');

export interface PtyOptions {
  /** An absolute path to an executable listed as a login shell. */
  readonly shell: string;
  /** Where the shell starts. */
  readonly cwd: string;
  /** The whole of the shell's environment: `terminalEnvironment` builds it. */
  readonly environment: Readonly<Record<string, string>>;
}

export interface PtyHooks {
  /** Output of the terminal, the marks that report its processes taken out. */
  output(bytes: Uint8Array): void;
  /** The terminal and its processes are known: it can be resized and ended. */
  ready(marks: TerminalMarks): void;
  /** The login shell exited with this code, or the launch itself failed with `null`. Called once. */
  exit(code: number | null): void;
}

export interface CloseResult {
  /** The shell exited, nothing is left on its terminal and the launcher's process group is gone. */
  readonly confirmed: boolean;
  readonly exitCode: number | null;
}

const run = promisify(execFile);
const pause = (milliseconds: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, milliseconds); });

function signal(pid: number | undefined, name: NodeJS.Signals): void {
  if (pid === undefined) return;
  try { process.kill(pid, name); } catch { /* already gone */ }
}

/** A pseudo-terminal running one login shell. Nothing here is retried: every failure is reported
 * by the terminal ending. */
export class PtyTerminal {
  private readonly child: ChildProcess;
  private readonly scanner = new MarkScanner();
  private readonly exitWaiters = new Set<() => void>();
  private readonly markWaiters = new Set<() => void>();
  private marks: TerminalMarks | undefined;
  private size: { readonly cols: number; readonly rows: number } | undefined;
  private applying: Promise<void> = Promise.resolve();
  private resizeQueued = false;
  private exited = false;
  private exitCode: number | null = null;
  private closing: Promise<CloseResult> | undefined;
  /** The last of what the launcher wrote to its error stream, for a failure to say. */
  private errors = '';

  constructor(options: PtyOptions, private readonly hooks: PtyHooks) {
    this.child = spawn('/bin/zsh', ['-f', '-c', LAUNCH, SUPERVISOR], { cwd: options.cwd, env: options.environment, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    // A write to a terminal that has gone fails; the exit that follows is what reports it.
    this.child.stdin?.on('error', () => { /* reported by exit */ });
    this.child.stdout?.on('data', (chunk: Buffer) => { this.received(chunk); });
    this.child.stderr?.on('error', () => { /* the terminal's own output is its stdout */ });
    this.child.stderr?.on('data', (chunk: Buffer) => { this.errors = (this.errors + chunk.toString('utf8')).slice(-2048); });
    this.child.once('error', () => { this.ended(null); });
    this.child.once('exit', code => { this.ended(code); });
  }

  /** @returns Whether the terminal is still there to write to. */
  get alive(): boolean { return !this.exited; }
  /** @returns What the marks reported, once they did. */
  get reported(): TerminalMarks | undefined { return this.marks; }
  /** @returns The last of the launcher's error output. */
  get errorOutput(): string { return this.errors; }
  /** @returns The launcher's pid, which heads its process group. */
  get launcher(): number | undefined { return this.child.pid; }

  /** Sends input to the terminal. @returns Whether it was sent; a terminal that exited takes nothing. */
  write(bytes: Uint8Array): boolean {
    if (this.exited || this.child.stdin === null || this.child.stdin.destroyed) return false;
    this.child.stdin.write(Buffer.from(bytes));
    return true;
  }

  /** Sets the terminal's size. A request made before the terminal is known is kept until it is. */
  resize(cols: number, rows: number): void {
    this.size = { cols, rows };
    if (this.marks === undefined || this.exited || this.resizeQueued) return;
    this.resizeQueued = true;
    this.applying = this.applying.then(async () => {
      this.resizeQueued = false;
      const size = this.size;
      const tty = this.marks?.tty;
      // Only the latest size is applied: requests that pile up while one is in flight coalesce.
      if (size === undefined || tty === undefined || this.exited || size !== this.size) return;
      await run('/bin/stty', ['-f', tty, 'rows', String(size.rows), 'cols', String(size.cols)]).catch(() => { /* a terminal that went reports by its exit */ });
    });
  }

  /** Ends the shell and everything on its terminal. Hanging up is what a closed terminal does to
   * a shell; termination and killing follow only if that is not enough. The supervisor, still
   * holding the terminal, sweeps what the shell left and exits with its status; should it not,
   * it is killed, then its group, then whatever still holds the terminal. */
  close(timeoutMilliseconds = 2000): Promise<CloseResult> {
    this.closing ??= this.closeWithin(timeoutMilliseconds);
    return this.closing;
  }

  private async closeWithin(timeoutMilliseconds: number): Promise<CloseResult> {
    const deadline = performance.now() + timeoutMilliseconds;
    // Asked for before the terminal reported itself: a moment's wait for the report is worth more
    // than ending at once, since only the report says which processes to end.
    if (!this.exited && this.marks === undefined) await this.waitForMarks(Math.min(300, timeoutMilliseconds));
    if (!this.exited && this.marks !== undefined) {
      for (const name of ['SIGHUP', 'SIGTERM', 'SIGKILL'] as const) {
        signal(this.marks.shell, name);
        if (await this.waitExit(Math.min(500, Math.max(0, deadline - performance.now())))) break;
      }
    }
    // The supervisor exits with the shell once it has swept the terminal; give it the time left.
    await this.waitExit(Math.max(0, deadline - performance.now()));
    if (!this.exited) {
      signal(this.marks?.supervisor, 'SIGKILL');
      // The launcher heads its own process group, the one the shell and its jobs were started in.
      if (this.child.pid !== undefined) signal(-this.child.pid, 'SIGKILL');
      await this.waitExit(Math.max(0, Math.min(400, deadline - performance.now())));
    }
    // The pipe the input was forwarded through closes with the terminal; its reader ends on that
    // and leaves the group. Only then is the group's absence worth checking.
    this.child.stdin?.destroy();
    let confirmed = this.exited;
    if (confirmed && this.marks !== undefined) {
      const tty = this.marks.tty;
      for (let attempt = 0; attempt < 10; attempt++) {
        const left = await this.onTerminal(tty);
        for (const pid of left) signal(pid, 'SIGKILL');
        if (left.length === 0 && !this.groupPresent()) break;
        await pause(20);
      }
      confirmed = (await this.onTerminal(tty)).length === 0 && !this.groupPresent();
    }
    return { confirmed, exitCode: this.exitCode };
  }

  private received(chunk: Uint8Array): void {
    const output = this.scanner.push(chunk);
    if (output.length > 0) this.hooks.output(output);
    const marks = this.scanner.marks;
    if (marks !== undefined && this.marks === undefined) {
      this.marks = marks;
      for (const wake of [...this.markWaiters]) wake();
      this.hooks.ready(marks);
      // A size asked for before the terminal was known is the size it starts with.
      if (this.size !== undefined && !this.resizeQueued) this.resize(this.size.cols, this.size.rows);
    }
  }

  private ended(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.child.stdin?.destroy();
    for (const wake of [...this.exitWaiters]) wake();
    this.hooks.exit(code);
  }

  /** @returns Whether the terminal ended, by the given time at the latest. */
  private waitExit(milliseconds: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    return new Promise<boolean>(resolve => {
      const done = (): void => { clearTimeout(timer); this.exitWaiters.delete(done); resolve(this.exited); };
      const timer = setTimeout(done, Math.max(0, milliseconds));
      this.exitWaiters.add(done);
    });
  }

  /** @returns When the terminal reports itself, or when the time is up, whichever is first. */
  private waitForMarks(milliseconds: number): Promise<void> {
    if (this.marks !== undefined || this.exited) return Promise.resolve();
    return new Promise<void>(resolve => {
      const done = (): void => { clearTimeout(timer); this.markWaiters.delete(done); resolve(); };
      const timer = setTimeout(done, Math.max(0, milliseconds));
      this.markWaiters.add(done);
    });
  }

  /** Whether the launcher's process group still has a member. */
  private groupPresent(): boolean {
    if (this.child.pid === undefined) return false;
    try { process.kill(-this.child.pid, 0); return true; } catch { return false; }
  }

  /** The processes still on a terminal, by what `ps` lists for it. */
  private async onTerminal(tty: string): Promise<number[]> {
    const listing = await run(PS_TTY_LISTING[0], [...PS_TTY_LISTING[1]]).then(result => result.stdout, () => '');
    return pidsOnTty(listing, tty);
  }
}
