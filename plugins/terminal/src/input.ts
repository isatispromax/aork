/** What is typed, sent in as few writes as possible and in order. Pure logic with its timers
 * injected, so it is unit-tested in Node: the body gives it animation frames and timeouts.
 * Keystrokes arrive one event at a time; sending each as its own request would flood the Host
 * while a key is held down. What is typed during a frame — or while an earlier write is in
 * flight — waits and goes in the next write. A write that fails for a reason that may pass is
 * tried again; one that fails because the terminal is gone gives up. */

export type SendResult = 'sent' | 'retry' | 'stopped';

/** How much may wait to be sent. Past it the oldest of what is typed is dropped: a paste larger
 * than this is more than a terminal can be trusted to take in one go. */
export const PENDING_LIMIT = 256 * 1024;
const RETRY_MILLISECONDS = 300;

export class InputQueue {
  private chunks: Uint8Array[] = [];
  private size = 0;
  private running = false;
  private scheduled = false;
  private dropped = 0;
  private stopped = false;

  /** @param send - Carries one bounded write; says how it went.
   * @param frame - Runs a callback on the next animation frame.
   * @param later - Runs a callback after a delay. */
  constructor(
    private readonly send: (bytes: Uint8Array) => Promise<SendResult>,
    private readonly writeBytes: number,
    private readonly frame: (callback: () => void) => void = callback => { requestAnimationFrame(() => callback()); },
    private readonly later: (callback: () => void, milliseconds: number) => void = (callback, milliseconds) => { setTimeout(callback, milliseconds); },
  ) {}

  /** How many of the oldest typed bytes were dropped for waiting too long behind others. */
  get droppedBytes(): number { return this.dropped; }

  /** Queues input to send. */
  push(bytes: Uint8Array): void {
    if (this.stopped || bytes.length === 0) return;
    this.chunks.push(bytes);
    this.size += bytes.length;
    while (this.size > PENDING_LIMIT) {
      const oldest = this.chunks[0]!;
      const excess = this.size - PENDING_LIMIT;
      if (oldest.length <= excess) { this.chunks.shift(); this.size -= oldest.length; this.dropped += oldest.length; }
      else { this.chunks[0] = oldest.subarray(excess); this.size -= excess; this.dropped += excess; }
    }
    this.schedule();
  }

  /** Sends what is waiting now, in the order it was typed. */
  async flush(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.size > 0 && !this.stopped) {
        const chunk = this.take(this.writeBytes);
        const result = await this.send(chunk);
        if (result === 'sent') continue;
        this.chunks.unshift(chunk);
        this.size += chunk.length;
        // The terminal is gone: nothing sent now would reach it.
        if (result === 'stopped') { this.stopped = true; this.clear(); return; }
        await new Promise<void>(resolve => { this.later(resolve, RETRY_MILLISECONDS); });
      }
    } finally { this.running = false; }
  }

  /** Gives up on the terminal: what is waiting is dropped and nothing more is sent. */
  stop(): void { this.stopped = true; this.clear(); }
  /** Lets a terminal started in this one's place be written to again. */
  revive(): void { this.stopped = false; }

  private clear(): void { this.chunks = []; this.size = 0; }

  private schedule(): void {
    if (this.scheduled || this.running) return;
    this.scheduled = true;
    this.frame(() => { this.scheduled = false; void this.flush(); });
  }

  /** Takes up to `limit` bytes off the front, splitting the first chunk only when it alone is larger. */
  private take(limit: number): Uint8Array {
    const taken: Uint8Array[] = [];
    let total = 0;
    while (this.chunks.length && total < limit) {
      const first = this.chunks[0]!;
      const room = limit - total;
      if (first.length > room) {
        taken.push(first.subarray(0, room));
        this.chunks[0] = first.subarray(room);
        total += room;
      } else {
        this.chunks.shift();
        taken.push(first);
        total += first.length;
      }
    }
    this.size -= total;
    if (taken.length === 1) return taken[0]!;
    const joined = new Uint8Array(total);
    let at = 0;
    for (const part of taken) { joined.set(part, at); at += part.length; }
    return joined;
  }
}

/** Bytes as the base64 a write carries. */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  // Built in pieces: spreading a large array into a call overflows the stack.
  for (let at = 0; at < bytes.length; at += 8192) binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return btoa(binary);
}

/** The base64 a read carries, as bytes. */
export function decodeBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
