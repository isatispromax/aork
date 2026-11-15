import type { Readable, Writable } from 'node:stream';
import type { OwnerDescriptor } from '@aork/sdk/server';
export const RUNNER_SERVICE = 'aork.runner.local@1';
/** Trusted server-only service. Only live handles created by this Runner can be stopped. */
export interface ManagedProcess {
  readonly stdout: Readable;
  readonly stdin: Writable;
  readonly exited: Promise<void>;
  readonly identity: Readonly<{ pid: number; group: number }>;
  /** Registered work must acknowledge cancellation before stop can be confirmed. */
  registerJob(cancel: () => void | Promise<void>): () => void;
  stop(): Promise<{ confirmed: boolean }>;
}
export interface LocalRunner {
  spawn(owner: OwnerDescriptor, launch: Readonly<{ executable: string; arguments: readonly string[]; cwd: string; environment: Readonly<Record<string, string>> }>): ManagedProcess;
}
