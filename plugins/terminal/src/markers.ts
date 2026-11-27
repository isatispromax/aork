/** Finds the two private marks a starting terminal reports itself with, and takes them out of
 * its output. Pure logic. The terminal's supervisor writes, as the first thing it does, which
 * tty it owns and its own pid, then the pid of the login shell it started — as OSC sequences no
 * program produces. They can still be split across reads, and the shell's first output can land
 * between them, so this holds bytes back only while they might still turn out to be part of a
 * mark. */

const BEL = 0x07;
/** `ESC ] 7777 ;` — followed by `<tty>;<supervisor pid>` and `BEL`. */
const TTY_MARK = [0x1b, 0x5d, 0x37, 0x37, 0x37, 0x37, 0x3b];
/** `ESC ] 7778 ;` — followed by `<login shell pid>` and `BEL`. */
const SHELL_MARK = [0x1b, 0x5d, 0x37, 0x37, 0x37, 0x38, 0x3b];
/** A mark is a few dozen bytes at most; longer than this without its bell, it is not one. */
const MARK_LIMIT = 256;

/** What the marks said about a started terminal. */
export interface TerminalMarks {
  /** The terminal's device, as `tty` reports it: `/dev/ttys003`. */
  readonly tty: string;
  /** The process that sweeps the terminal when the shell exits, and exits with its status. */
  readonly supervisor: number;
  /** The login shell, started as a job of the supervisor. */
  readonly shell: number;
}

/** The marks are device names and numbers, which need no more than this. */
const LATIN1 = new TextDecoder('latin1');

function startsWith(bytes: Uint8Array, at: number, prefix: readonly number[]): boolean {
  if (at + prefix.length > bytes.length) return false;
  for (let index = 0; index < prefix.length; index++) if (bytes[at + index] !== prefix[index]) return false;
  return true;
}

/** A pid as the marks carry one: a positive integer and nothing else. */
function pidOf(text: string): number | undefined {
  return /^[1-9][0-9]{0,9}$/.test(text) ? Number(text) : undefined;
}

export class MarkScanner {
  /** Bytes held back because they may yet turn out to be part of a mark. */
  private pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
  private ttyMark: { readonly tty: string; readonly supervisor: number } | undefined;
  private shellMark: number | undefined;

  /** Whether both marks were read; output passes through untouched from then on. */
  get done(): boolean { return this.ttyMark !== undefined && this.shellMark !== undefined; }

  /** The marks, once both were read. */
  get marks(): TerminalMarks | undefined {
    return this.ttyMark && this.shellMark !== undefined ? { tty: this.ttyMark.tty, supervisor: this.ttyMark.supervisor, shell: this.shellMark } : undefined;
  }

  /** @param chunk - What the terminal wrote. @returns The output in it that is not a mark. */
  push(chunk: Uint8Array): Uint8Array {
    if (this.done) return this.pending.length ? concat([this.pending, chunk]) : chunk;
    this.pending = concat([this.pending, chunk]);
    const out: Uint8Array[] = [];
    let at = 0;
    // Set when a mark was started but is not whole yet: everything from it on is kept until it is.
    let incomplete = false;
    while (at < this.pending.length) {
      const tty = this.ttyMark === undefined && startsWith(this.pending, at, TTY_MARK);
      const shell = this.shellMark === undefined && startsWith(this.pending, at, SHELL_MARK);
      if (!tty && !shell) { at++; continue; }
      if (at > 0) { out.push(this.pending.slice(0, at)); this.pending = this.pending.slice(at); at = 0; }
      const prefix = tty ? TTY_MARK : SHELL_MARK;
      // The bell ends the mark; one that has not arrived yet leaves the rest of the output waiting.
      const found = this.pending.subarray(prefix.length).indexOf(BEL);
      const bell = found === -1 ? -1 : found + prefix.length;
      if (bell === -1) {
        // Not whole yet. A mark this long is not coming: let the bytes go and look again past them.
        if (this.pending.length < MARK_LIMIT) { incomplete = true; break; }
        out.push(this.pending.slice(0, 1));
        this.pending = this.pending.slice(1);
        continue;
      }
      const body = LATIN1.decode(this.pending.subarray(prefix.length, bell));
      const read = tty ? readTty(body) : pidOf(body);
      if (read === undefined) {
        // Shaped like a mark but saying nothing usable: output, not a mark.
        out.push(this.pending.slice(0, 1));
        this.pending = this.pending.slice(1);
        continue;
      }
      if (tty) this.ttyMark = read as { tty: string; supervisor: number };
      else this.shellMark = read as number;
      this.pending = this.pending.slice(bell + 1);
    }
    if (this.done) { out.push(this.pending); this.pending = new Uint8Array(); return concat(out); }
    // Hold back a mark that is not whole yet, or what may still be the start of one.
    const hold = incomplete ? this.pending.length : this.trailingPrefix();
    const release = this.pending.length - hold;
    if (release > 0) { out.push(this.pending.slice(0, release)); this.pending = this.pending.slice(release); }
    return concat(out);
  }

  /** How many of the last held bytes are the start of a mark not read yet. */
  private trailingPrefix(): number {
    const wanted: readonly number[][] = [...(this.ttyMark === undefined ? [TTY_MARK] : []), ...(this.shellMark === undefined ? [SHELL_MARK] : [])];
    for (let hold = Math.min(this.pending.length, TTY_MARK.length - 1); hold > 0; hold--) {
      if (wanted.some(mark => startsWith(this.pending, this.pending.length - hold, mark.slice(0, hold)))) return hold;
    }
    return 0;
  }
}

function readTty(body: string): { tty: string; supervisor: number } | undefined {
  const separator = body.lastIndexOf(';');
  if (separator === -1) return undefined;
  const supervisor = pidOf(body.slice(separator + 1));
  const tty = body.slice(0, separator);
  // What `tty` prints: a device under /dev. Anything else is not the report this waits for.
  if (supervisor === undefined || !/^\/dev\/[A-Za-z0-9_./-]+$/.test(tty)) return undefined;
  return { tty, supervisor };
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { joined.set(part, at); at += part.length; }
  return joined;
}
