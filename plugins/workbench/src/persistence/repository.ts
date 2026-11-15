import { repositoryNamespace, type RepositoryDeclaration } from '@aork/sdk/server';
const n = repositoryNamespace('workbench');
export const persistence: RepositoryDeclaration = { namespace: n, migrations: [{ version: 1, statements: [
                `CREATE TABLE ${n}replies (ordinal INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, principal TEXT NOT NULL, session_id TEXT NOT NULL, record TEXT NOT NULL, opened INTEGER NOT NULL DEFAULT 0)`,
                `CREATE INDEX ${n}unread ON ${n}replies(principal,opened,ordinal)`,
                `CREATE TABLE ${n}preferences (principal TEXT PRIMARY KEY, record TEXT NOT NULL)`
            ] }], statements: {
        insert: { sql: `INSERT OR IGNORE INTO ${n}replies (id,principal,session_id,record) VALUES (?,?,?,?)`, mode: 'write' },
        count: { sql: `SELECT count(*) AS count FROM ${n}replies WHERE principal=? AND opened=0`, mode: 'read' },
        list: { sql: `SELECT CAST(ordinal AS TEXT) AS cursor,record FROM ${n}replies WHERE principal=? AND opened=0 AND ordinal>? ORDER BY ordinal LIMIT 51`, mode: 'read' },
        get: { sql: `SELECT id FROM ${n}replies WHERE principal=? AND session_id=? AND id=?`, mode: 'read' },
        read: { sql: `UPDATE ${n}replies SET opened=1 WHERE principal=? AND session_id=? AND id=?`, mode: 'write' },
        preferences: { sql: `SELECT record FROM ${n}preferences WHERE principal=?`, mode: 'read' },
        savePreferences: { sql: `INSERT OR REPLACE INTO ${n}preferences (principal,record) VALUES (?,?)`, mode: 'write' }
    } };
