import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { AorkError } from '@aork/sdk';
import { repositoryNamespace } from '@aork/sdk/server';
import type { JsonValue } from '@aork/sdk';
import type { CommandReceipt, DurableEvent } from '@aork/sdk/durable';
import type { DurableCommandRegistration, OwnerRepository, RepositoryDeclaration, RequestContext, SqlValue, SyncTransaction } from '@aork/sdk/server';

function canonical(value: unknown, depth = 0): string {
  if (depth > 64) throw new AorkError('INVALID_PAYLOAD', 'Command JSON exceeds the supported nesting depth');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], depth + 1)}`).join(',')}}`;
  throw new AorkError('INVALID_PAYLOAD', 'Command payload must be finite JSON');
}
function parse<T>(schema: { parse(value: unknown): T }, value: unknown, code: string, status = 400): T {
  try { return schema.parse(value); } catch { throw new AorkError(code, code === 'INVALID_PAYLOAD' ? 'Command payload is invalid' : 'Plugin returned an invalid result or event', status); }
}

/** Generic, single-connection writer; no business schema or invariants belong here. */
export function createDurableStorage(sqlite: Database.Database) {
  sqlite.transaction(() => sqlite.exec(`
    CREATE TABLE IF NOT EXISTS host_migrations (owner TEXT NOT NULL, version INTEGER NOT NULL, checksum TEXT NOT NULL, PRIMARY KEY(owner, version));
    CREATE TABLE IF NOT EXISTS command_receipts (principal TEXT NOT NULL, command_id TEXT NOT NULL, fingerprint TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(principal, command_id));
    CREATE TABLE IF NOT EXISTS durable_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, owner TEXT NOT NULL, principal TEXT NOT NULL, type TEXT NOT NULL, version INTEGER NOT NULL, entity_id TEXT NOT NULL, payload TEXT NOT NULL, command_id TEXT NOT NULL, occurred_at TEXT NOT NULL);
  `))();
  const live = new WeakSet<object>();
  let healthy = true;
  const requireLive = (token: SyncTransaction) => { if (!live.has(token)) throw new AorkError('TRANSACTION_INVALID', 'Transaction is no longer active', 500); };
  const receiptRow = sqlite.prepare('SELECT fingerprint, receipt FROM command_receipts WHERE principal = ? AND command_id = ?');
  function find(principal: string, commandId: string, fingerprint?: string): CommandReceipt | undefined {
    const row = receiptRow.get(principal, commandId) as { fingerprint: string; receipt: string } | undefined;
    if (row && fingerprint !== undefined && row.fingerprint !== fingerprint) throw new AorkError('COMMAND_ID_CONFLICT', 'This commandId was already committed with different content', 409);
    return row ? JSON.parse(row.receipt) as CommandReceipt : undefined;
  }
  function bind(owner: string, declaration?: RepositoryDeclaration, options: {allowMigrations?:boolean} = {}): OwnerRepository {
    const statements = new Map<string, { statement: Database.Statement; mode: 'read' | 'write' }>();
    if (declaration) {
      const namespace = repositoryNamespace(owner);
      if (declaration.namespace !== namespace) throw new Error('Repository namespace must belong to its Plugin');
      // This prevents accidental cross-owner use by trusted Plugins, not malicious SQL sandboxing.
      const check = (sql: string) => {
        if (sql.includes(';') || /--|\/\*|\b(?:pragma|attach|detach)\b/i.test(sql)) throw new Error('Repository requires a single scoped statement');
        for (const match of sql.matchAll(/\b(?:from|join|update|into|table(?:\s+if\s+not\s+exists)?|references|on|index(?:\s+if\s+not\s+exists)?)\s+["`\[]?([a-zA-Z_][\w]*)/gi)) if (!match[1]!.startsWith(namespace)) throw new Error('Repository statement references another owner');
      };
      let previous = 0;
      sqlite.transaction(() => {
        const known = sqlite.prepare('SELECT version, checksum FROM host_migrations WHERE owner = ? ORDER BY version').all(owner) as Array<{ version: number; checksum: string }>;
        if (known.length > declaration.migrations.length) throw new Error('Plugin schema is newer than this package');
        for (const migration of declaration.migrations) {
          if (!Number.isSafeInteger(migration.version) || migration.version !== previous + 1) throw new Error('Plugin migrations must be ordered consecutively');
          previous = migration.version;
          const checksum = createHash('sha256').update(canonical(migration.statements)).digest('hex');
          const existing = known.find(row => row.version === migration.version);
          if (existing) { if (existing.checksum !== checksum) throw new Error('Plugin migration checksum changed'); continue; }
          if(options.allowMigrations===false)throw new AorkError('PLUGIN_MAINTENANCE_REQUIRED',`${owner} needs a schema migration; use the upgrade maintenance workflow`,409);
          for (const sql of migration.statements) { check(sql); if (!/^CREATE\s+(TABLE|INDEX|UNIQUE\s+INDEX)\b/i.test(sql)) throw new Error('Unsupported initial schema migration'); sqlite.exec(sql); }
          sqlite.prepare('INSERT INTO host_migrations (owner,version,checksum) VALUES (?,?,?)').run(owner, migration.version, checksum);
        }
      })();
      for (const [name, definition] of Object.entries(declaration.statements)) {
        check(definition.sql);
        const statement = sqlite.prepare(definition.sql);
        if (definition.mode === 'read' ? !statement.reader || !/^SELECT\b/i.test(definition.sql) : statement.reader || !/^(INSERT|UPDATE|DELETE)\b/i.test(definition.sql)) throw new Error('Repository statement mode is invalid');
        statements.set(name, { statement, mode: definition.mode });
      }
    }
    return Object.freeze({
      all<Row>(name: string, values: readonly SqlValue[] = [], transaction?: SyncTransaction): Row[] {
        if (transaction) requireLive(transaction);
        const entry = statements.get(name); if (!entry || entry.mode !== 'read') throw new AorkError('REPOSITORY_STATEMENT_INVALID', 'Unknown owner read statement', 500);
        return entry.statement.all(...values) as Row[];
      },
      run(transaction: SyncTransaction, name: string, values: readonly SqlValue[] = []) {
        requireLive(transaction);
        const entry = statements.get(name); if (!entry || entry.mode !== 'write') throw new AorkError('REPOSITORY_STATEMENT_INVALID', 'Unknown owner write statement', 500);
        return { changes: entry.statement.run(...values).changes };
      },
    });
  }
  return {
    bind,
    receipt(principal: string, commandId: string) { return find(principal, commandId); },
    events(principal: string, after = '0', limit = 100): DurableEvent[] {
      if (typeof after !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(after) || BigInt(after) > 9223372036854775807n || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new AorkError('INVALID_CURSOR', 'Use a decimal cursor and a limit from 1 to 100');
      return (sqlite.prepare('SELECT CAST(seq AS TEXT) AS seq, id, owner, type, version, entity_id AS entityId, payload, command_id AS commandId, occurred_at AS occurredAt FROM durable_events WHERE principal = ? AND seq > CAST(? AS INTEGER) ORDER BY seq LIMIT ?').all(principal, after, limit) as Array<Omit<DurableEvent, 'payload' | 'visibility'> & { payload: string }>).map(row => ({ ...row, visibility: 'browser', payload: JSON.parse(row.payload) as JsonValue }));
    },
    async execute(owner: string, name: string, registration: DurableCommandRegistration, input: { commandId: string; version: number; payload: unknown }, request: RequestContext): Promise<CommandReceipt> {
      if (!request.identity) throw new AorkError('AUTHENTICATION_REQUIRED', 'An authenticated identity is required', 401);
      const fingerprint = createHash('sha256').update(canonical({ name, version: input.version, payload: input.payload })).digest('hex');
      const original = find(request.identity, input.commandId, fingerprint); if (original) return original;
      if (input.version !== registration.version) throw new AorkError('COMMAND_VERSION_UNSUPPORTED', 'Command version is unsupported', 409);
      const payload = parse(registration.payload, input.payload, 'INVALID_PAYLOAD');
      if (!healthy) throw new AorkError('STORAGE_UNAVAILABLE', 'Durable storage requires local maintenance or a Host restart', 503);
      const prepared = await registration.prepare?.(payload, request);
      try {
        return sqlite.transaction(() => {
          const duplicate = find(request.identity!, input.commandId, fingerprint); if (duplicate) return duplicate;
          if (!healthy) throw new AorkError('STORAGE_UNAVAILABLE', 'Durable storage requires local maintenance or a Host restart', 503);
          const token = Object.freeze({}) as SyncTransaction; live.add(token);
          try {
            const change = registration.execute(payload, prepared, token, request);
            if (!change || typeof change !== 'object') throw new AorkError('INVALID_COMMAND_RESULT', 'Plugin returned an invalid command result', 500);
            if ('then' in change) {
              // Invalid JavaScript participants can return rejected Promises despite the SDK type.
              // Consume the detached rejection; every later write still sees an expired token.
              void Promise.resolve(change).catch(() => {});
              throw new AorkError('TRANSACTION_ASYNC', 'Transaction participants must be synchronous', 500);
            }
            const result = parse(registration.result, change.result, 'INVALID_COMMAND_RESULT', 500);
            canonical(result);
            const occurredAt = new Date().toISOString();
            const events = change.events.map(draft => {
              const contract = registration.events[draft.type];
              if (!contract || contract.version !== draft.version || !/^[a-z][a-zA-Z0-9.]*$/.test(draft.type) || typeof draft.entityId !== 'string' || draft.entityId.length > 128) throw new AorkError('INVALID_COMMAND_EVENT', 'Plugin returned an invalid event', 500);
              const eventPayload = parse(contract.payload, draft.payload, 'INVALID_COMMAND_EVENT', 500); const encoded = canonical(eventPayload);
              if (Buffer.byteLength(encoded) > 32 * 1024) throw new AorkError('INVALID_COMMAND_EVENT', 'Event exceeds the supported size', 500);
              const id = randomUUID();
              const seq = sqlite.prepare('INSERT INTO durable_events (id,owner,principal,type,version,entity_id,payload,command_id,occurred_at) VALUES (?,?,?,?,?,?,?,?,?)').safeIntegers().run(id, owner, request.identity!, draft.type, draft.version, draft.entityId, encoded, input.commandId, occurredAt).lastInsertRowid.toString();
              return { id, seq };
            });
            const receipt: CommandReceipt = { commandId: input.commandId, name, version: input.version, outcome: 'completed', result: result as JsonValue, committedAt: occurredAt, events };
            const encodedReceipt = canonical(receipt);
            sqlite.prepare('INSERT INTO command_receipts (principal,command_id,fingerprint,receipt) VALUES (?,?,?,?)').run(request.identity!, input.commandId, fingerprint, encodedReceipt);
            return JSON.parse(encodedReceipt) as CommandReceipt;
          } finally { live.delete(token); }
        })();
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && String(error.code).startsWith('SQLITE_')) { healthy = false; throw new AorkError('STORAGE_UNAVAILABLE', 'Durable storage requires local maintenance or a Host restart', 503); }
        throw error;
      }
    },
  };
}
export type DurableStorage = ReturnType<typeof createDurableStorage>;
