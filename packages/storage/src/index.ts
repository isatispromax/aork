import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sqliteTable, text, primaryKey } from 'drizzle-orm/sqlite-core';
import { eq, and } from 'drizzle-orm';
import { flockSync } from 'fs-ext';
import { openSync, closeSync, constants, fchmodSync } from 'node:fs';
import { chmod, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { DistributionProfile, JsonValue } from '@aork/sdk';
import type { ScopedState } from '@aork/sdk/server';

const settings = sqliteTable('host_settings', { key: text('key').primaryKey(), value: text('value').notNull() });
const state = sqliteTable('plugin_state', { plugin: text('plugin').notNull(), key: text('key').notNull(), value: text('value').notNull() }, table => [primaryKey({ columns: [table.plugin, table.key] })]);

/** The only routine write connection; callers acquire the data-instance lock first. */
export async function openStorage(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const dataDir = await realpath(directory);
  await chmod(dataDir, 0o700);
  // Never unlink this inode: the kernel owns exclusivity for the descriptor lifetime,
  // including event-loop stalls and SIGSTOP. Exit/crash releases it without stale-lock guesses.
  const descriptor = openSync(join(dataDir, 'host.lock'), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try { fchmodSync(descriptor, 0o600); flockSync(descriptor, 'exnb'); }
  catch (error) {
    closeSync(descriptor);
    if (error && typeof error === 'object' && 'code' in error && ['EAGAIN', 'EWOULDBLOCK'].includes(String(error.code))) {
      const locked = new Error('This data instance is already locked by another Host or maintenance command') as NodeJS.ErrnoException; locked.code = 'ELOCKED'; throw locked;
    }
    throw error;
  }
  let released = false;
  const release = () => { if (released) return; released = true; closeSync(descriptor); };
  let sqlite: Database.Database | undefined;
  try {
    sqlite = new Database(join(dataDir, 'aork.sqlite'));
    await chmod(join(dataDir, 'aork.sqlite'), 0o600);
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    sqlite.pragma('busy_timeout = 5000');
    sqlite.pragma('synchronous = FULL');
    sqlite.exec(`CREATE TABLE IF NOT EXISTS host_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS plugin_state (plugin TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (plugin, key));`);
    const db = drizzle(sqlite);
    let closed = false;
    return {
      dataDir,
      loadStartup(): JsonValue | undefined {
        const row = db.select().from(settings).where(eq(settings.key, 'startup')).get();
        return row ? JSON.parse(row.value) as JsonValue : undefined;
      },
      saveStartup(startup: JsonValue) {
        db.insert(settings).values({ key: 'startup', value: JSON.stringify(startup) }).onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(startup) } }).run();
      },
      loadProfile(): DistributionProfile | undefined {
        const row = db.select().from(settings).where(eq(settings.key, 'profile')).get();
        return row ? JSON.parse(row.value) as DistributionProfile : undefined;
      },
      saveProfile(profile: DistributionProfile) {
        db.insert(settings).values({ key: 'profile', value: JSON.stringify(profile) }).onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(profile) } }).run();
      },
      scope(pluginId: string): ScopedState {
        return {
          get<T extends JsonValue>(key: string): T | undefined { const row = db.select().from(state).where(and(eq(state.plugin, pluginId), eq(state.key, key))).get(); return row ? JSON.parse(row.value) as T : undefined; },
          set(key, value) { db.insert(state).values({ plugin: pluginId, key, value: JSON.stringify(value) }).onConflictDoUpdate({ target: [state.plugin, state.key], set: { value: JSON.stringify(value) } }).run(); },
        };
      },
      async close() { if (closed) return; closed = true; sqlite!.close(); await release(); },
    };
  } catch (error) { sqlite?.close(); await release(); throw error; }
}
export type Storage = Awaited<ReturnType<typeof openStorage>>;
