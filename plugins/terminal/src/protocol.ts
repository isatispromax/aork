/** What the terminal plugin's own two halves say to each other, and the bounds the server holds
 * every request to. Pure constants and types: the server validates with them and the client
 * sizes what it sends by them, so neither guesses the other's limits. */

/** The bounds of one terminal and of all of them together. */
export const TERMINAL_LIMITS = {
  /** Terminals running at once. */
  concurrent: 8,
  /** Decoded bytes one write may carry. The transport caps a JSON request body at 64 KiB, and
   * base64 makes every three bytes four characters; a paste is sent in several writes. */
  writeBytes: 32 * 1024,
  /** Screen size, inclusive. */
  cols: [2, 500] as const,
  rows: [1, 200] as const,
  /** Output kept for a reader that was away: the last this many bytes are replayed. */
  ringBytes: 256 * 1024,
  /** Output carried by one read, so a reader that fell far behind catches up in a few round trips. */
  chunkBytes: 192 * 1024,
  /** How long a read that finds nothing new waits for something before answering empty. Short on
   * purpose: the Host waits for reads in flight to finish before it closes. */
  pollMilliseconds: 500,
} as const;

export type TerminalState = 'starting' | 'running' | 'exited';

/** One terminal as the server sees it. `exitCode` is set once the shell has exited. */
export interface TerminalInfo {
  readonly terminalId: string;
  readonly shell: string;
  readonly state: TerminalState;
  readonly exitCode: number | null;
  readonly cols: number;
  readonly rows: number;
}

/** What one read of a terminal's output returns: the bytes at positions `[from, next)`, and the
 * terminal's state as of the answer. `from` is past what the reader asked for when the reader was
 * away longer than the kept output: the rest was dropped and the screen is best cleared. */
export interface TerminalOutput {
  readonly terminalId: string;
  readonly from: number;
  readonly next: number;
  /** Base64. */
  readonly data: string;
  readonly state: TerminalState;
  readonly exitCode: number | null;
}

/** A shell the server found and will start a terminal in. */
export interface ShellInfo {
  readonly path: string;
  readonly name: string;
}

export interface TerminalShells {
  readonly shells: readonly ShellInfo[];
  /** The path a terminal starts in when none is named. */
  readonly default: string;
}

export const TERMINAL_COMMANDS = {
  /** `{ terminalId, shell?, cols?, rows?, workspaceId? }` → `TerminalInfo`. Starts a shell; a terminal that already exists and is running is refused. */
  create: 'terminal.create',
  /** `{ terminalId, data }` → `{}`. `data` is base64 of at most `writeBytes`. */
  write: 'terminal.write',
  /** `{ terminalId, cols, rows }` → `{}`. */
  resize: 'terminal.resize',
  /** `{ terminalId }` → `{ confirmed: boolean }`. Ends the shell and everything it left on its terminal. */
  close: 'terminal.close',
} as const;

export const TERMINAL_QUERIES = {
  /** → `TerminalShells`. */
  shells: 'terminal.shells',
  /** → `{ terminals: TerminalInfo[] }`. */
  list: 'terminal.list',
} as const;

/** `?terminalId=&after=` → JSON `TerminalOutput`. */
export const TERMINAL_OUTPUT_RESOURCE = 'terminal.output';

/** The failures of the terminal commands, each with its own code. */
export const TERMINAL_FAILURES = [
  'TERMINAL_INPUT_INVALID', 'TERMINAL_NOT_FOUND', 'TERMINAL_EXISTS', 'TERMINAL_EXITED', 'TERMINAL_LIMIT',
  'TERMINAL_INPUT_TOO_LARGE', 'TERMINAL_PLATFORM_UNSUPPORTED', 'TERMINAL_SHELL_UNKNOWN', 'TERMINAL_START_FAILED',
] as const;
export type TerminalFailure = typeof TERMINAL_FAILURES[number];
