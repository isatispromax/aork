import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { OutputRing } from '../plugins/terminal/src/ring.js';
import { MarkScanner } from '../plugins/terminal/src/markers.js';
import type { TerminalMarks } from '../plugins/terminal/src/markers.js';
import { pidsOnTty, PS_TTY_LISTING } from '../plugins/terminal/src/sweep.js';
import { defaultShell, INHERITED_NAMES, parseShells, shellName, terminalEnvironment } from '../plugins/terminal/src/shells.js';
import { PtyTerminal } from '../plugins/terminal/src/launch.js';
import { TERMINAL_LIMITS } from '../plugins/terminal/src/protocol.js';
import { decodeBase64, encodeBase64, InputQueue, PENDING_LIMIT } from '../plugins/terminal/src/input.js';
import type { SendResult } from '../plugins/terminal/src/input.js';

const ESC = 0x1b, BEL = 0x07;
const encoder = new TextEncoder();
const bytes = (...values: number[]) => new Uint8Array(values);
/** The tty mark a supervisor writes: `ESC ] 7777 ; <tty>;<pid> BEL`. */
const ttyMark = (tty: string, pid: number) => new Uint8Array([ESC, 0x5d, 0x37, 0x37, 0x37, 0x37, 0x3b, ...encoder.encode(`${tty};${pid}`), BEL]);
/** The shell mark: `ESC ] 7778 ; <pid> BEL`. */
const shellMark = (pid: number) => new Uint8Array([ESC, 0x5d, 0x37, 0x37, 0x37, 0x38, 0x3b, ...encoder.encode(String(pid)), BEL]);
const text = (value: Uint8Array) => new TextDecoder('latin1').decode(value);

describe('terminal output ring', () => {
  it('hands a reader what was written after where it stopped, and says where to ask from next', () => {
    const ring = new OutputRing(16);
    expect(ring.read(0)).toEqual({ from: 0, next: 0, data: new Uint8Array() });
    ring.append(encoder.encode('hello '));
    ring.append(encoder.encode('world'));
    expect(text(ring.read(0).data)).toBe('hello world');
    expect(ring.read(6)).toMatchObject({ from: 6, next: 11 });
    expect(text(ring.read(6).data)).toBe('world');
    expect(ring.read(11)).toEqual({ from: 11, next: 11, data: new Uint8Array() });
  });

  it('keeps only the newest of what does not fit, and tells a reader that fell behind where the answer starts', () => {
    const ring = new OutputRing(8);
    ring.append(encoder.encode('01234567'));
    expect(text(ring.read(0).data)).toBe('01234567');
    ring.append(encoder.encode('89abcdef'));
    expect(ring.cursor).toBe(16);
    expect(ring.oldest).toBe(8);
    const behind = ring.read(0);
    expect(behind.from).toBe(8);
    expect(text(behind.data)).toBe('89abcdef');
    // The buffer wraps: what comes next overwrites the oldest, and a reader that kept up loses nothing.
    ring.append(encoder.encode('XYZ'));
    expect(text(ring.read(16).data)).toBe('XYZ');
    // Eight are kept: the last five of what was there, then the three.
    expect(ring.read(ring.oldest)).toMatchObject({ from: 11, next: 19 });
    expect(text(ring.read(ring.oldest).data)).toBe('bcdefXYZ');
  });

  it('drops what cannot be kept when one write is larger than the whole buffer', () => {
    const ring = new OutputRing(4);
    ring.append(encoder.encode('abcdefgh'));
    expect(text(ring.read(0).data)).toBe('efgh');
    expect(ring.append(encoder.encode('')), undefined);
    expect(ring.cursor).toBe(8);
  });

  it('answers at most a limit at a time and wakes whoever is waiting, also when nothing was written', () => {
    const ring = new OutputRing(64);
    ring.append(encoder.encode('abcdef'));
    expect(text(ring.read(0, 4).data)).toBe('abcd');
    expect(text(ring.read(4, 4).data)).toBe('ef');
    let told = 0;
    const stop = ring.onChange(() => { told++; });
    ring.append(encoder.encode('x'));
    ring.wake();
    stop();
    ring.wake();
    expect(told).toBe(2);
    expect(TERMINAL_LIMITS.chunkBytes).toBeLessThanOrEqual(TERMINAL_LIMITS.ringBytes);
  });
});

describe('terminal start marks', () => {
  it('takes both marks out of the output and reports what they said', () => {
    const scanner = new MarkScanner();
    const output = scanner.push(new Uint8Array([...ttyMark('/dev/ttys003', 4711), ...encoder.encode('welcome\r\n'), ...shellMark(4712), ...encoder.encode('$ ')]));
    expect(text(output)).toBe('welcome\r\n$ ');
    expect(scanner.done).toBe(true);
    expect(scanner.marks).toEqual({ tty: '/dev/ttys003', supervisor: 4711, shell: 4712 } satisfies TerminalMarks);
  });

  it('finds marks that a read split, holding back only what may still be their start', () => {
    const whole = new Uint8Array([...ttyMark('/dev/ttys009', 7), ...encoder.encode('ok'), ...shellMark(8), ...encoder.encode('!')]);
    // The stream as reads of every length would split it: one byte at a time, unevenly, whole.
    for (let size = 1; size <= whole.length; size++) {
      const scanner = new MarkScanner();
      let seen = '';
      for (let at = 0; at < whole.length; at += size) seen += text(scanner.push(whole.subarray(at, at + size)));
      expect(seen, `pieces of ${size}`).toBe('ok!');
      expect(scanner.marks, `pieces of ${size}`).toEqual({ tty: '/dev/ttys009', supervisor: 7, shell: 8 });
    }
  });

  it('lets output that merely looks like the start of a mark go once it is plain it is not one', () => {
    const scanner = new MarkScanner();
    // A bare escape at the end of a read is held, then released when the next byte rules a mark out.
    expect(text(scanner.push(bytes(0x41, ESC)))).toBe('A');
    expect(text(scanner.push(bytes(0x5b, 0x41)))).toBe('\x1b[A');
    // Started like a mark and not a mark after all: let go as soon as the next byte says so.
    expect(text(scanner.push(new Uint8Array([...ttyMark('/dev/ttys001', 5).subarray(0, 5), ...bytes(0x58)])))).toBe('\x1b]777X');
    // No bell within any reasonable length: not a mark, and all of it is output.
    const endless = new Uint8Array([...ttyMark('/dev/ttys001', 5).subarray(0, 7), ...new Uint8Array(300).fill(0x58)]);
    expect(scanner.push(endless)).toEqual(endless);
    // A shape that says nothing usable is output, not a mark.
    expect(scanner.push(new Uint8Array([ESC, 0x5d, 0x37, 0x37, 0x37, 0x37, 0x3b, 0x3f, BEL]))).toEqual(new Uint8Array([ESC, 0x5d, 0x37, 0x37, 0x37, 0x37, 0x3b, 0x3f, BEL]));
    expect(scanner.done).toBe(false);
  });

  it('passes output through untouched once both marks were read', () => {
    const scanner = new MarkScanner();
    scanner.push(new Uint8Array([...ttyMark('/dev/ttys002', 1), ...shellMark(2), ...bytes(0x61)]));
    expect(scanner.push(bytes(ESC, 0x5d, 0x37, 0x37, 0x37, 0x37, 0x3b, BEL))).toEqual(bytes(ESC, 0x5d, 0x37, 0x37, 0x37, 0x37, 0x3b, BEL));
  });
});

describe('what shares a terminal', () => {
  it('reads the pids ps lists for a device, leaving other terminals and the excluded out', () => {
    const listing = '   501 ttys000\n 7102 ttys003\n 7103 ttys003\n 7104 ??\n 9      ttys003\n';
    expect(pidsOnTty(listing, '/dev/ttys003')).toEqual([7102, 7103, 9]);
    expect(pidsOnTty(listing, '/dev/ttys003', [7103])).toEqual([7102, 9]);
    expect(pidsOnTty(listing, 'ttys001')).toEqual([]);
    expect(pidsOnTty('', '/dev/ttys003')).toEqual([]);
    expect(PS_TTY_LISTING[0]).toBe('/bin/ps');
  });
});

describe('shells and their environment', () => {
  it('lists the login shells a shells file names, once each and in order', () => {
    expect(parseShells('# $FreeBSD$\n/bin/sh\n/bin/bash\t\n/bin/zsh \n\n# /bin/tcsh\nrelative/sh\n/bin/zsh\n')).toEqual(['/bin/sh', '/bin/bash', '/bin/zsh']);
    expect(shellName('/opt/homebrew/bin/fish')).toBe('fish');
  });

  it('starts in the account\'s own shell where it is listed, else in the first one listed', () => {
    expect(defaultShell(['/bin/sh', '/bin/zsh'], '/bin/zsh')).toBe('/bin/zsh');
    expect(defaultShell(['/bin/sh'], '/opt/homebrew/bin/fish')).toBe('/bin/sh');
    expect(defaultShell(['/bin/sh'], undefined)).toBe('/bin/sh');
    expect(defaultShell([], '/bin/zsh')).toBeUndefined();
  });

  it('hands a shell only what it needs to find the account, its files and its programs', () => {
    const environment = terminalEnvironment({ HOME: '/Users/a', USER: 'a', PATH: '/usr/bin', AORK_SECRET: 'token', NODE_ENV: 'test', LANG: 'zh_CN.UTF-8', BAD: 'x\0y' }, '/bin/zsh');
    expect(environment).toEqual({ HOME: '/Users/a', USER: 'a', PATH: '/usr/bin', LANG: 'zh_CN.UTF-8', SHELL: '/bin/zsh', TERM: 'xterm-256color', AORK_SHELL: '/bin/zsh' });
    expect(INHERITED_NAMES).not.toContain('AORK_SECRET');
    expect(terminalEnvironment({}, '/bin/sh')).toEqual({ SHELL: '/bin/sh', TERM: 'xterm-256color', AORK_SHELL: '/bin/sh' });
  });
});

/** The launcher on this machine: real shells on real pseudo-terminals. macOS only, as the launcher is. */
const macos = process.platform === 'darwin';
const run = promisify(execFile);
const pause = (milliseconds: number) => new Promise(resolve => { setTimeout(resolve, milliseconds); });

describe.skipIf(!macos)('a terminal on this machine', () => {
  let home = '';
  beforeAll(async () => { home = await mkdtemp(join(tmpdir(), 'aork-terminal-home-')); });
  afterAll(async () => { await rm(home, { recursive: true, force: true }); });

  /** Starts `/bin/sh` as a login shell with an empty home, so nothing of the account's own is read. */
  function start() {
    const output: number[] = [];
    const events: { marks?: TerminalMarks; exit?: number | null } = {};
    const environment = terminalEnvironment({ ...process.env, HOME: home, AORK_CANARY: 'must-not-reach-the-shell' }, '/bin/sh', { cols: 80, rows: 24 });
    const pty = new PtyTerminal({ shell: '/bin/sh', cwd: home, environment }, {
      output: (chunk) => { output.push(...chunk); },
      ready: (marks) => { events.marks = marks; },
      exit: (code) => { events.exit = code; },
    });
    const seen = () => new TextDecoder('latin1').decode(new Uint8Array(output));
    return { pty, events, seen };
  }
  /** Types a line for the shell and waits for what it answers. */
  async function answer(terminal: ReturnType<typeof start>, command: string, expected: RegExp, milliseconds = 8000): Promise<string> {
    const before = terminal.seen().length;
    terminal.pty.write(encoder.encode(`${command}\r`));
    for (const until = performance.now() + milliseconds; performance.now() < until;) {
      // A terminal echoes what is typed: the answer is looked for after the echoed line, so a
      // command that contains its own answer cannot match itself.
      const written = terminal.seen().slice(before);
      const echoed = written.indexOf('\r\n');
      const match = echoed === -1 ? null : expected.exec(written.slice(echoed + 2));
      if (match) return match[1] ?? match[0];
      await pause(20);
    }
    throw new Error(`the shell never answered ${command}: ${JSON.stringify(terminal.seen().slice(before))}`);
  }
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  it('reports its terminal and processes, resizes, and exits with the shell\'s status', async () => {
    const terminal = start();
    try {
      for (const until = performance.now() + 5000; terminal.events.marks === undefined && performance.now() < until;) await pause(20);
      const marks = terminal.events.marks!;
      expect(marks.tty).toMatch(/^\/dev\/ttys[0-9]+$/);
      expect(alive(marks.supervisor)).toBe(true);
      expect(alive(marks.shell)).toBe(true);
      // Set by the supervisor before the shell started.
      expect(await answer(terminal, 'stty size', /(\d+ \d+)/)).toBe('24 80');
      terminal.pty.resize(100, 30);
      await pause(150);
      expect(await answer(terminal, 'stty size', /(\d+ \d+)/)).toBe('30 100');
      // The shell is a login shell on a terminal of its own, and it is the job the terminal is for.
      expect(await answer(terminal, 'test -t 0 && test -t 1 && echo tty', /(tty)/)).toBe('tty');
      // Only what the whitelist names reached it: the canary set on the Host is not there.
      expect(await answer(terminal, 'echo "[$AORK_CANARY][$TERM][$0]"', /(\[[^\]]*\]\[[^\]]*\]\[[^\]]*\])/)).toBe('[][xterm-256color][/bin/sh]');
      terminal.pty.write(encoder.encode('exit 7\r'));
      for (const until = performance.now() + 5000; terminal.events.exit === undefined && performance.now() < until;) await pause(20);
      expect(terminal.events.exit).toBe(7);
      expect(terminal.pty.write(encoder.encode('x'))).toBe(false);
      expect(await terminal.pty.close(1000)).toEqual({ confirmed: true, exitCode: 7 });
    } finally { await terminal.pty.close(3000); }
  }, 30000);

  it('ends what the shell left in the background when the shell exits', async () => {
    const terminal = start();
    try {
      for (const until = performance.now() + 5000; terminal.events.marks === undefined && performance.now() < until;) await pause(20);
      const stubborn = Number(await answer(terminal, 'sleep 300 & echo PID=$!', /PID=([0-9]+)/));
      expect(alive(stubborn)).toBe(true);
      terminal.pty.write(encoder.encode('exit\r'));
      for (const until = performance.now() + 5000; terminal.events.exit === undefined && performance.now() < until;) await pause(20);
      expect(terminal.events.exit).toBe(0);
      // The supervisor sweeps before it lets go of the terminal, so nothing lingers after it.
      await pause(200);
      expect(alive(stubborn)).toBe(false);
    } finally { await terminal.pty.close(3000); }
  }, 30000);

  it('ends a shell that is busy and confirms that nothing of it is left', async () => {
    const terminal = start();
    try {
      for (const until = performance.now() + 5000; terminal.events.marks === undefined && performance.now() < until;) await pause(20);
      const marks = terminal.events.marks!;
      const stubborn = Number(await answer(terminal, 'sleep 300 & echo PID=$!', /PID=([0-9]+)/));
      terminal.pty.write(encoder.encode('sleep 300\r'));
      const started = performance.now();
      const result = await terminal.pty.close(2000);
      // Hung up on, the shell exits with the hang-up signal's status.
      expect(result).toMatchObject({ confirmed: true, exitCode: 129 });
      expect(performance.now() - started).toBeLessThan(2500);
      expect(alive(stubborn)).toBe(false);
      expect(alive(marks.shell)).toBe(false);
      const listing = (await run(PS_TTY_LISTING[0], [...PS_TTY_LISTING[1]])).stdout;
      expect(pidsOnTty(listing, marks.tty)).toEqual([]);
    } finally { await terminal.pty.close(3000); }
  }, 30000);

  it('ends a terminal it was asked to end before that terminal reported itself', async () => {
    const terminal = start();
    const started = performance.now();
    const result = await terminal.pty.close(2000);
    // It waits only for the report that names what to end, not for the whole time allowed.
    expect(result).toMatchObject({ confirmed: true, exitCode: 129 });
    expect(performance.now() - started).toBeLessThan(1500);
    expect(terminal.events.marks).toBeDefined();
  }, 15000);
});

describe.skipIf(!macos)('the shells this machine lists', () => {
  it('is a file this machine has, and its default shell is one of them', async () => {
    const listed = parseShells(await readFile('/etc/shells', 'utf8'));
    expect(listed.length).toBeGreaterThan(0);
    expect(listed).toContain('/bin/sh');
    await access('/bin/sh', constants.X_OK);
    expect(defaultShell(listed, process.env.SHELL)).toBeDefined();
  });
});

/** An input queue with its timers held: frames and delays run only when the test says so. */
function queued(send: (bytes: Uint8Array) => Promise<SendResult>, writeBytes = 4) {
  const frames: (() => void)[] = [];
  const delays: (() => void)[] = [];
  const queue = new InputQueue(send, writeBytes, callback => { frames.push(callback); }, callback => { delays.push(callback); });
  // Lets every promise the queue is waiting on settle.
  const settle = async () => { for (let turn = 0; turn < 6; turn++) await new Promise<void>(resolve => { setTimeout(resolve, 0); }); };
  return {
    queue, frames, delays, settle,
    frame: async () => { const run = frames.shift(); run?.(); await settle(); },
    delay: async () => { const run = delays.shift(); run?.(); await settle(); },
  };
}

describe('terminal input queue', () => {
  it('sends what was typed during a frame as one write, in the order it was typed', async () => {
    const writes: string[] = [];
    const test = queued(async bytes => { writes.push(text(bytes)); return 'sent'; });
    test.queue.push(encoder.encode('e'));
    test.queue.push(encoder.encode('ch'));
    test.queue.push(encoder.encode('o'));
    expect(writes).toEqual([]);
    expect(test.frames).toHaveLength(1);
    await test.frame();
    expect(writes).toEqual(['echo']);
  });

  it('carries a paste in as many writes as the limit of one takes', async () => {
    const writes: number[] = [];
    const test = queued(async bytes => { writes.push(bytes.length); return 'sent'; });
    test.queue.push(new Uint8Array(10));
    await test.frame();
    expect(writes).toEqual([4, 4, 2]);
  });

  it('waits while a write is in flight, then sends what was typed meanwhile', async () => {
    const writes: string[] = [];
    let release: (result: SendResult) => void = () => { /* not yet writing */ };
    const test = queued(bytes => { writes.push(text(bytes)); return new Promise<SendResult>(resolve => { release = resolve; }); });
    test.queue.push(encoder.encode('a'));
    await test.frame();
    expect(writes).toEqual(['a']);
    test.queue.push(encoder.encode('b'));
    test.queue.push(encoder.encode('c'));
    expect(test.frames).toHaveLength(0);
    release('sent');
    await test.settle();
    expect(writes).toEqual(['a', 'bc']);
  });

  it('tries a write again after a failure that may pass, keeping its place', async () => {
    const writes: string[] = [];
    let attempts = 0;
    const test = queued(async bytes => { writes.push(text(bytes)); return ++attempts === 1 ? 'retry' : 'sent'; });
    test.queue.push(encoder.encode('x'));
    await test.frame();
    expect(writes).toEqual(['x']);
    expect(test.delays).toHaveLength(1);
    test.queue.push(encoder.encode('y'));
    await test.delay();
    // The retried write and what was typed meanwhile go together, in order.
    expect(writes).toEqual(['x', 'xy']);
  });

  it('gives up on a terminal that is gone, and serves one started in its place', async () => {
    const writes: string[] = [];
    const test = queued(async bytes => { writes.push(text(bytes)); return 'stopped'; });
    test.queue.push(encoder.encode('a'));
    await test.frame();
    expect(writes).toEqual(['a']);
    test.queue.push(encoder.encode('b'));
    await test.frame();
    expect(writes).toEqual(['a']);
    test.queue.revive();
    test.queue.push(encoder.encode('d'));
    await test.frame();
    expect(writes).toEqual(['a', 'd']);
  });

  it('drops the oldest of what waited too long behind others, and says how much', async () => {
    const writes: Uint8Array[] = [];
    const test = queued(async bytes => { writes.push(bytes); return 'sent'; }, 1024 * 1024);
    test.queue.push(new Uint8Array(200 * 1024).fill(1));
    test.queue.push(new Uint8Array(100 * 1024).fill(2));
    expect(test.queue.droppedBytes).toBe(300 * 1024 - PENDING_LIMIT);
    await test.frame();
    const sent = writes[0]!;
    expect(sent.length).toBe(PENDING_LIMIT);
    // The first byte kept is the one after all that was dropped.
    expect(sent[0]).toBe(1);
    expect(sent.subarray(0, 156 * 1024).every(byte => byte === 1)).toBe(true);
    expect(sent.subarray(156 * 1024).every(byte => byte === 2)).toBe(true);
  });

  it('carries bytes as the base64 a write is sent in, whatever the bytes', () => {
    const sample = new Uint8Array([...encoder.encode('终端 ✓ é'), ...Array.from({ length: 300 }, (_, index) => (index * 7) % 256)]);
    expect(decodeBase64(encodeBase64(sample))).toEqual(sample);
    expect(encodeBase64(new Uint8Array())).toBe('');
  });
});

