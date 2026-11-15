import { sql, type SQL } from 'drizzle-orm';
import { sqliteTable, text, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import type { OwnerRepository, RepositoryDeclaration, SyncTransaction } from '@aork/sdk/server';
import { profileSchema, credentialSchema } from '@aork/contracts/agent';
import type { AgentProfile, Credential } from '@aork/contracts/agent';
const profiles = sqliteTable('plugin_agent_hprofiles__profiles', { id: text('id').primaryKey(), record: text('record').notNull() });
const credentials = sqliteTable('plugin_agent_hprofiles__credentials', { id: text('id').primaryKey(), record: text('record').notNull(), encrypted: text('encrypted').notNull() });
const dialect = new SQLiteSyncDialect(); const p = (key: string) => sql.placeholder(key);
const statement = (query: SQL, mode: 'read' | 'write') => ({ sql: dialect.sqlToQuery(query).sql, mode });
export const persistence: RepositoryDeclaration = {
  namespace: 'plugin_agent_hprofiles__', migrations: [{ version: 1, statements: [
    'CREATE TABLE plugin_agent_hprofiles__profiles (id TEXT PRIMARY KEY, record TEXT NOT NULL)',
    'CREATE TABLE plugin_agent_hprofiles__credentials (id TEXT PRIMARY KEY, record TEXT NOT NULL, encrypted TEXT NOT NULL)',
  ] }], statements: {
    profiles: statement(sql`SELECT record FROM ${profiles} ORDER BY rowid`, 'read'),
    profile: statement(sql`SELECT record FROM ${profiles} WHERE id = ${p('id')}`, 'read'),
    insertProfile: statement(sql`INSERT INTO ${profiles} (id,record) VALUES (${p('id')},${p('record')})`, 'write'),
    updateProfile: statement(sql`UPDATE ${profiles} SET record = ${p('record')} WHERE id = ${p('id')}`, 'write'),
    credentials: statement(sql`SELECT record FROM ${credentials} ORDER BY rowid`, 'read'),
    credential: statement(sql`SELECT record,encrypted FROM ${credentials} WHERE id = ${p('id')}`, 'read'),
    insertCredential: statement(sql`INSERT INTO ${credentials} (id,record,encrypted) VALUES (${p('id')},${p('record')},${p('encrypted')})`, 'write'),
  },
};
export function agentRepository(binding: OwnerRepository) {
  return {
    profiles: () => binding.all<{ record: string }>('profiles').map(row => profileSchema.parse(JSON.parse(row.record))),
    profile(id: string, tx?: SyncTransaction) { const row = binding.all<{ record: string }>('profile', [id], tx)[0]; return row ? profileSchema.parse(JSON.parse(row.record)) : undefined; },
    insertProfile(tx: SyncTransaction, profile: AgentProfile) { binding.run(tx, 'insertProfile', [profile.id, JSON.stringify(profile)]); },
    updateProfile(tx: SyncTransaction, profile: AgentProfile) { binding.run(tx, 'updateProfile', [JSON.stringify(profile), profile.id]); },
    credentials: () => binding.all<{ record: string }>('credentials').map(row => credentialSchema.parse(JSON.parse(row.record))),
    credential(id: string, tx?: SyncTransaction) { const row = binding.all<{ record: string; encrypted: string }>('credential', [id], tx)[0]; return row ? { credential: credentialSchema.parse(JSON.parse(row.record)), encrypted: row.encrypted } : undefined; },
    insertCredential(tx: SyncTransaction, credential: Credential, encrypted: string) { binding.run(tx, 'insertCredential', [credential.id, JSON.stringify(credential), encrypted]); },
  };
}
