import type { JsonValue } from './index.js';

export interface EventReference { id: string; seq: string }
export interface CommandReceipt<T = JsonValue> {
  commandId: string; name: string; version: number; outcome: 'completed';
  result: T; committedAt: string; events: EventReference[];
}
export interface DurableEvent extends EventReference {
  owner: string; type: string; version: number; entityId: string;
  visibility: 'browser'; payload: JsonValue; commandId: string; occurredAt: string;
}
