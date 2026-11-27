/** The recent output of one terminal, for a reader that comes and goes. Pure logic. Every byte
 * a terminal wrote has a position that only grows; a reader says where it stopped reading and
 * gets what came after. A reader that was away longer than the kept output shows is given the
 * oldest of what is left and told, by where the answer starts, that it missed some. */

export interface OutputSlice {
  /** Position of the first byte returned. */
  readonly from: number;
  /** Position after the last byte returned: where to ask from next. */
  readonly next: number;
  readonly data: Uint8Array;
}

export class OutputRing {
  private readonly buffer: Uint8Array;
  /** Index in `buffer` where the next byte is written. */
  private head = 0;
  /** Bytes held. */
  private length = 0;
  /** Bytes ever appended: the position of the next byte to be appended. */
  private written = 0;
  private readonly listeners = new Set<() => void>();

  /** @param capacity - How many of the newest bytes are kept. */
  constructor(readonly capacity: number) {
    this.buffer = new Uint8Array(capacity);
  }

  /** Position after the last byte written. */
  get cursor(): number { return this.written; }
  /** Position of the oldest byte still held. */
  get oldest(): number { return this.written - this.length; }

  /** Keeps the newest of what a terminal wrote, dropping what no longer fits, and wakes every reader. */
  append(bytes: Uint8Array): void {
    const kept = bytes.subarray(Math.max(0, bytes.length - this.capacity));
    for (let offset = 0; offset < kept.length;) {
      const at = (this.head + offset) % this.capacity;
      const take = Math.min(kept.length - offset, this.capacity - at);
      this.buffer.set(kept.subarray(offset, offset + take), at);
      offset += take;
    }
    this.head = kept.length === 0 ? this.head : (this.head + kept.length) % this.capacity;
    this.length = Math.min(this.capacity, this.length + kept.length);
    this.written += bytes.length;
    for (const listener of [...this.listeners]) listener();
  }

  /** The bytes written after `after`, at most `limit` of them, in the order they were written. */
  read(after: number, limit = Infinity): OutputSlice {
    const from = Math.max(after, this.oldest);
    const end = Math.min(this.written, from + limit);
    if (end <= from) return { from, next: from, data: new Uint8Array() };
    const start = (this.head - this.length + this.capacity) % this.capacity;
    const data = new Uint8Array(end - from);
    for (let index = 0; index < data.length; index++) data[index] = this.buffer[(start + from - this.oldest + index) % this.capacity] ?? 0;
    return { from, next: end, data };
  }

  /** Wakes every reader without adding output: for a change that is not a byte, such as the
   * shell exiting. */
  wake(): void { for (const listener of [...this.listeners]) listener(); }

  /** @param listener - Told whenever a terminal writes. @returns Stops telling it. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
}
