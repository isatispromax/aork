import type { JsonValue } from './index.js';

export interface EventReference { id: string; seq: string }
export interface SnapshotEnvelope<T> { snapshot: T; streamId: string; cursor: string }
export type EventStreamFrame =
  | { kind: 'ready'; streamId: string; cursor: string }
  | { kind: 'events'; events: DurableEvent[]; cursor: string }
  | { kind: 'resync'; reason: string }
  | { kind: 'access'; state: 'unauthenticated' | 'unavailable' }
  | { kind: 'reload' };
export interface CommandReceipt<T = JsonValue> {
  commandId: string; name: string; version: number; outcome: 'completed';
  result: T; committedAt: string; events: EventReference[];
}
export interface DurableEvent extends EventReference {
  owner: string; type: string; version: number; entityId: string;
  visibility: 'browser'; payload: JsonValue; commandId: string; occurredAt: string;
}
