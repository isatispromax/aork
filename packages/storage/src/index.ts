import Database from 'better-sqlite3';
import { createDurableStorage } from './durable.js';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sqliteTable, text, primaryKey } from 'drizzle-orm/sqlite-core';
import { eq, and } from 'drizzle-orm';
import { flockSync } from 'fs-ext';
import { openSync, closeSync, constants, fchmodSync } from 'node:fs';
import { chmod, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { AorkError } from '@aork/sdk';
import type { DistributionProfile, JsonValue } from '@aork/sdk';
import type { ScopedState } from '@aork/sdk/server';

const settings = sqliteTable('host_settings', { key: text('key').primaryKey(), value: text('value').notNull() });
const state = sqliteTable('plugin_state', { plugin: text('plugin').notNull(), key: text('key').notNull(), value: text('value').notNull() }, table => [primaryKey({ columns: [table.plugin, table.key] })]);

/** One OS lock is shared by serve, maintenance and initial package installation. */
export async function acquireDataLock(directory: string) {
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
  return { dataDir, release };
}

/** The only routine write connection; callers acquire the data-instance lock first. */
export async function openStorage(directory: string) {
  const { dataDir, release } = await acquireDataLock(directory);
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
    const durable = createDurableStorage(sqlite);
    function selectedVersions() {
      const row=db.select().from(state).where(and(eq(state.plugin,'@host/lifecycle'),eq(state.key,'selectedVersions'))).get();
      const history: Record<string,string>=row?JSON.parse(row.value):{};
      const current=db.select().from(settings).where(eq(settings.key,'profile')).get();
      if(current)for(const selection of (JSON.parse(current.value) as DistributionProfile).plugins) {
        if(Object.hasOwn(history,selection.id)&&history[selection.id]!==selection.version)throw new AorkError('PLUGIN_VERSION_HISTORY_INVALID','Saved plugin version history disagrees with the current profile; use maintenance',409);
        history[selection.id]=selection.version;
      }
      return history;
    }
    function checkProfile(profile:DistributionProfile, checkUnknownState=true) {
      const history=selectedVersions();
      for(const selection of profile.plugins) {
        if(Object.hasOwn(history,selection.id)) {
          if(history[selection.id]!==selection.version)throw new AorkError('PLUGIN_VERSION_CHANGE_REQUIRES_MAINTENANCE',`${selection.id} has a previous exact version; use the upgrade maintenance workflow`,409);
        } else if(checkUnknownState&&(db.select().from(state).where(eq(state.plugin,selection.id)).get()||sqlite!.prepare('SELECT 1 FROM host_migrations WHERE owner = ? LIMIT 1').get(selection.id)))throw new AorkError('PLUGIN_HISTORY_UNKNOWN',`${selection.id} has stored data without known version history; use local maintenance`,409);
      }
      return history;
    }
    let closed = false;
    return {
      dataDir,
      durable,
      checkProfile,
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
        sqlite!.transaction(()=>{
          const history=checkProfile(profile,false);
          for(const selection of profile.plugins)history[selection.id]=selection.version;
          db.insert(settings).values({key:'profile',value:JSON.stringify(profile)}).onConflictDoUpdate({target:settings.key,set:{value:JSON.stringify(profile)}}).run();
          db.insert(state).values({plugin:'@host/lifecycle',key:'selectedVersions',value:JSON.stringify(history)}).onConflictDoUpdate({target:[state.plugin,state.key],set:{value:JSON.stringify(history)}}).run();
        })();
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
export type { DurableStorage } from './durable.js';
