/** The terminal plugin's server half: login shells on pseudo-terminals, run as the Host's own
 * system user and reached from the browser through commands and bounded reads. The terminal is
 * the user's own shell. It is not a managed writer: it holds no Workspace Claim, checks none, and
 * whatever it changes on disk is reconciled by the file service's revision checks, not by it. The
 * browser names a shell the Host listed and an id of its own choosing; it never hands over a
 * command. */
import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { AorkError } from '@aork/sdk';
import type { ServerPluginContext } from '@aork/sdk/server';
import type { WorkspaceService } from '@aork/contracts/workspace';
import { PtyTerminal } from './launch.js';
import { OutputRing } from './ring.js';
import { SHELLS_FILE, defaultShell, parseShells, shellName, terminalEnvironment } from './shells.js';
import { TERMINAL_LIMITS, type ShellInfo, type TerminalInfo, type TerminalOutput, type TerminalShells, type TerminalState } from './protocol.js';

/** How long `terminal.create` waits for the terminal to report itself before answering. */
const START_TIMEOUT = 3000;
/** How long ending a terminal is given before the next, harder step is taken. */
const CLOSE_TIMEOUT = 2000;
/** The same, when the plugin itself is being unloaded: every terminal ends within this. */
const DISPOSE_TIMEOUT = 1500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

interface Terminal {
  readonly id: string;
  readonly shell: string;
  readonly ring: OutputRing;
  /** Set once, right after the record is: the terminal's hooks need the record to report into. */
  pty: PtyTerminal;
  state: TerminalState;
  exitCode: number | null;
  cols: number;
  rows: number;
}

/** A refusal: declared, not assigned, so that what follows a refusal is known not to run. */
function fail(code: string, message: string, status: number): never { throw new AorkError(code, message, status); }
const json = (value: unknown) => ({ bytes: Buffer.from(JSON.stringify(value)), mediaType: 'application/json' as const });

export function activate(context: ServerPluginContext) {
  context.requireCapability('process.spawn');
  const terminals = new Map<string, Terminal>();
  let disposing = false;
  // Only this platform's launcher is written; elsewhere nothing is offered.
  const supported = process.platform === 'darwin';

  /* Input: each field checked on its own, so a refusal names the field. */
  function object(value: unknown): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail('TERMINAL_INPUT_INVALID', 'The payload must be an object', 400);
    return value as Record<string, unknown>;
  }
  function idOf(value: unknown): string {
    if (typeof value !== 'string' || !UUID.test(value)) return fail('TERMINAL_INPUT_INVALID', 'terminalId must be a UUID', 400);
    return value.toLowerCase();
  }
  function dimension(value: unknown, name: 'cols' | 'rows', fallback: number): number {
    if (value === undefined) return fallback;
    const [least, most] = TERMINAL_LIMITS[name];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < least || value > most) return fail('TERMINAL_INPUT_INVALID', `${name} must be an integer from ${least} to ${most}`, 400);
    return value;
  }
  function cursor(value: unknown): number {
    if (value === undefined) return 0;
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(value)) return fail('TERMINAL_INPUT_INVALID', 'after must be a position in the output', 400);
    return Number(value);
  }

  /* Shells, and where a terminal starts. */
  async function executable(path: string): Promise<boolean> {
    try { await access(path, constants.X_OK); return true; } catch { return false; }
  }
  async function shells(): Promise<TerminalShells> {
    if (!supported) return { shells: [], default: '' };
    const listed = parseShells(await readFile(SHELLS_FILE, 'utf8').catch(() => ''));
    const found: ShellInfo[] = [];
    for (const path of listed) if (await executable(path)) found.push({ path, name: shellName(path) });
    return { shells: found, default: defaultShell(found.map(shell => shell.path), process.env.SHELL) ?? '' };
  }
  /** A terminal starts in the Workspace selected where it is opened; without one, at home. */
  async function workingDirectory(workspaceId: unknown): Promise<string> {
    if (typeof workspaceId !== 'string') return homedir();
    try {
      const workspace = context.service<WorkspaceService>('aork.workspace@1').requireOpenWorkspace(workspaceId);
      if ((await stat(workspace.directory)).isDirectory()) return workspace.directory;
    } catch { /* an unavailable Workspace is no reason to refuse a terminal */ }
    return homedir();
  }

  const info = (terminal: Terminal): TerminalInfo => ({ terminalId: terminal.id, shell: terminal.shell, state: terminal.state, exitCode: terminal.exitCode, cols: terminal.cols, rows: terminal.rows });
  function running(id: string): Terminal {
    const terminal = terminals.get(id);
    if (terminal === undefined) fail('TERMINAL_NOT_FOUND', 'This terminal no longer exists', 404);
    if (terminal.state === 'exited') fail('TERMINAL_EXITED', 'The shell of this terminal has exited', 409);
    return terminal;
  }
  /** Resolves when the terminal next writes or changes, or when the time is up, whichever is first. */
  function changed(terminal: Terminal, milliseconds: number): Promise<void> {
    return new Promise<void>(resolve => {
      const stop = terminal.ring.onChange(() => { stop(); clearTimeout(timer); resolve(); });
      const timer = setTimeout(() => { stop(); resolve(); }, milliseconds);
    });
  }

  async function create(payload: unknown): Promise<TerminalInfo> {
    const input = object(payload);
    const id = idOf(input.terminalId);
    if (!supported) fail('TERMINAL_PLATFORM_UNSUPPORTED', 'This Host cannot start terminals on its platform', 503);
    const offered = await shells();
    // The shell is one the Host listed, by its exact path: nothing else is started.
    const named: unknown = input.shell === undefined ? offered.default : input.shell;
    if (typeof named !== 'string' || !offered.shells.some(item => item.path === named)) fail('TERMINAL_SHELL_UNKNOWN', 'Name a shell this Host lists', 400);
    const shell = named;
    const previous = terminals.get(id);
    if (previous && previous.state !== 'exited') fail('TERMINAL_EXISTS', 'This terminal is already running', 409);
    if ([...terminals.values()].filter(terminal => terminal.state !== 'exited').length >= TERMINAL_LIMITS.concurrent) fail('TERMINAL_LIMIT', `At most ${TERMINAL_LIMITS.concurrent} terminals run at once`, 409);
    const cols = dimension(input.cols, 'cols', 80);
    const rows = dimension(input.rows, 'rows', 24);
    const cwd = await workingDirectory(input.workspaceId);
    // A terminal that exited keeps its tab; starting one under the same id replaces it.
    if (previous) terminals.delete(id);
    const terminal: Terminal = { id, shell, ring: new OutputRing(TERMINAL_LIMITS.ringBytes), pty: undefined as unknown as PtyTerminal, state: 'starting', exitCode: null, cols, rows };
    terminals.set(id, terminal);
    const pty = new PtyTerminal({ shell, cwd, environment: terminalEnvironment(process.env, shell, { cols, rows }) }, {
      output: (bytes) => { terminal.ring.append(bytes); },
      ready: () => { terminal.state = 'running'; terminal.ring.wake(); },
      exit: (code) => { terminal.state = 'exited'; terminal.exitCode = code; terminal.ring.wake(); },
    });
    terminal.pty = pty;
    // Applied as soon as the terminal reports its device.
    pty.resize(cols, rows);
    await changed(terminal, START_TIMEOUT);
    if (terminal.state === 'exited') {
      terminals.delete(id);
      fail('TERMINAL_START_FAILED', 'The shell did not start', 503);
    }
    return info(terminal);
  }

  async function write(payload: unknown): Promise<{ written: number }> {
    const input = object(payload);
    const terminal = running(idOf(input.terminalId));
    const data = input.data;
    if (typeof data !== 'string' || !BASE64.test(data)) fail('TERMINAL_INPUT_INVALID', 'data must be base64', 400);
    if (data.length > Math.ceil(TERMINAL_LIMITS.writeBytes / 3) * 4) fail('TERMINAL_INPUT_TOO_LARGE', `A write carries at most ${TERMINAL_LIMITS.writeBytes} bytes`, 413);
    const bytes = new Uint8Array(Buffer.from(data, 'base64'));
    if (!terminal.pty.write(bytes)) fail('TERMINAL_EXITED', 'The shell of this terminal has exited', 409);
    return { written: bytes.length };
  }

  function resize(payload: unknown): { cols: number; rows: number } {
    const input = object(payload);
    const id = idOf(input.terminalId);
    const terminal = terminals.get(id);
    if (terminal === undefined) fail('TERMINAL_NOT_FOUND', 'This terminal no longer exists', 404);
    const cols = dimension(input.cols, 'cols', terminal.cols);
    const rows = dimension(input.rows, 'rows', terminal.rows);
    // A terminal that exited keeps the size it is asked for, so one started in its place begins with it.
    terminal.cols = cols;
    terminal.rows = rows;
    if (terminal.state !== 'exited') terminal.pty.resize(cols, rows);
    return { cols, rows };
  }

  async function close(payload: unknown): Promise<{ terminalId: string; confirmed: boolean; exitCode: number | null }> {
    const id = idOf(object(payload).terminalId);
    const terminal = terminals.get(id);
    // A terminal already gone is closed, as far as its caller is concerned.
    if (terminal === undefined) return { terminalId: id, confirmed: true, exitCode: null };
    // Gone from the list at once, so nothing more reaches its shell while it ends.
    terminals.delete(id);
    const result = await terminal.pty.close(CLOSE_TIMEOUT);
    return { terminalId: id, confirmed: result.confirmed, exitCode: result.exitCode };
  }

  async function output(parameters: Readonly<Record<string, string>>): Promise<TerminalOutput> {
    const id = idOf(parameters.terminalId);
    const after = cursor(parameters.after);
    const terminal = terminals.get(id);
    if (terminal === undefined) fail('TERMINAL_NOT_FOUND', 'This terminal no longer exists', 404);
    // Nothing new yet: wait for output or a change of state, but never longer than a read can hold
    // the plugin — the Host waits for reads in flight before it closes.
    if (terminal.ring.read(after, 1).data.length === 0 && terminal.state !== 'exited' && !disposing) await changed(terminal, TERMINAL_LIMITS.pollMilliseconds);
    const slice = terminal.ring.read(after, TERMINAL_LIMITS.chunkBytes);
    return { terminalId: id, from: slice.from, next: slice.next, data: Buffer.from(slice.data).toString('base64'), state: terminal.state, exitCode: terminal.exitCode };
  }

  context.command('terminal.create', { access: 'authenticated', execute: create });
  context.command('terminal.write', { access: 'authenticated', execute: write });
  context.command('terminal.resize', { access: 'authenticated', execute: resize });
  context.command('terminal.close', { access: 'authenticated', execute: close });
  context.query('terminal.shells', { access: 'authenticated', execute: shells });
  context.query('terminal.list', { access: 'authenticated', execute: () => ({ terminals: [...terminals.values()].map(info) }) });
  context.resource('terminal.output', { maxBytes: 384 * 1024, async read(parameters) { return json(await output(parameters)); } });
  // A terminal is work the Host is holding: while any runs, a change to the plugins is refused.
  context.lifecycleGuard({
    acquireChange() {
      return { state: [...terminals.values()].some(terminal => terminal.state !== 'exited') ? 'busy' : 'idle', release() { /* nothing is held between the question and the change */ } };
    },
  });
  context.effect(() => async () => {
    disposing = true;
    for (const terminal of terminals.values()) terminal.ring.wake();
    // Reads in flight answer at once, and every shell is ended, within the time the Host allows.
    await Promise.all([...terminals.values()].map(terminal => terminal.pty.close(DISPOSE_TIMEOUT)));
    terminals.clear();
  });
}
