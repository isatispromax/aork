# Projects and Workspaces

The default `workspace` Plugin supplies Project and Workspace data and the replaceable `aork.workspace.browser@1` view. The default workbench mounts that child contract. The browser's project tree, forms and directory details belong to this Plugin; the Host has no Project or Workspace imports.

Create a Project with its first Workspace, then add more Workspaces to the Project. A managed Workspace creates a fresh directory below the instance's `workspaces` directory. An external Workspace registers an existing absolute directory on the Host machine with explicit read-only or read-write authorization for that directory and its descendants. The UI displays the canonical server path, and also the requested path when it was an alias. A directory need not contain Git metadata.

Project and Workspace IDs are distinct UUIDs and remain stable when names change. The browser stores entity selection in its URL fragment and restores it on reload. Editing a Workspace can change its name and access mode; it revalidates the real directory and recorded device/inode. Moving or replacing an external directory requires a new registration. Archive preserves all registration records and files. Archiving a Project does not cascade into its Workspaces; archived Projects reject new Workspace creation and edits. “显示归档” exposes the retained records.

## Public commands and queries

All business HTTP routes require the existing signed browser Cookie. Commands also require the canonical Origin, the Cookie's CSRF header and the current plugin graph hash. They retain the Token access rules from ticket03.

`POST /api/commands/<name>` accepts:

```json
{
  "apiVersion": 1,
  "commandVersion": 1,
  "commandId": "one-stable-client-generated-id",
  "pluginGraphHash": "the-current-bootstrap-graph-hash",
  "payload": {}
}
```

| Name | Payload |
| --- | --- |
| `workspace.createProject` | `{name, workspace}` |
| `workspace.create` | `{projectId, workspace}` |
| `workspace.editProject` | `{id, name}` |
| `workspace.edit` | `{id, name, access}` |
| `workspace.archiveProject` | `{id}` |
| `workspace.archive` | `{id}` |

A managed workspace input is `{name, management:"managed"}`. An external input is `{name, management:"external", directory:"/absolute/path", access:"read-only"}` or `"read-write"`. Public schemas live in `@aork/contracts/workspace`; unknown payload fields are rejected. `GET /api/queries/workspace.overview` returns authoritative Projects and Workspaces, including archived registrations.

Success returns an immutable `{commandId, name, version, outcome:"completed", result, committedAt, events:[{id,seq}]}` receipt. The receipt is also available at `GET /api/receipts/<commandId>` to the same authenticated instance principal. Signing-key rotation/recovery preserves that principal, so accepted commands remain deduplicated after obtaining a new Cookie.

The fingerprint covers command name, command version and the original parsed JSON payload with object keys sorted. Arrays and values retain their meaning; trimming a display name or adding an explicit default is a different payload even if its normalized business value would match. The same principal and ID with changed content returns `409 COMMAND_ID_CONFLICT`. The original receipt is returned before touching directories on a retry, even after the directory disappears or the entity is edited. Authentication, CSRF, Origin and graph checks still precede receipt replay.

## Persistence and event inspection

One locked Host opens the only SQLite connection, with WAL, foreign keys, 5000ms busy timeout and FULL synchronization. The workspace Plugin owns its schema, foreign key, migration checksum and private Drizzle statement compiler. SDK repository bindings expose only declared owner-scoped read statements and writes requiring a live opaque synchronous transaction. No driver or Drizzle object enters the SDK or browser bundle. A live token may be passed through an explicit semantic service for a later cross-Plugin transaction; cached or other-instance tokens are rejected.

Directory preparation and validation run before the database transaction. Domain changes, runtime-schema-validated result, sanitized browser event and successful receipt commit together in one short synchronous transaction. A failed validation or transaction has no visible partial entity, success event or receipt. External directories are never removed as rollback. An unsuccessful managed command can leave an unreferenced prepared directory; this version retains it rather than deleting potentially useful files. There is no claim that filesystem and SQLite commits are atomic.

`GET /api/events?after=0&limit=100` is an authenticated bounded inspection API. It returns only this principal's sanitized browser events. `after` must be a canonical nonnegative decimal string up to SQLite's signed 64-bit maximum; `limit` is 1–100. Event IDs and decimal string sequences persist across restart. Keep sequences as strings/BigInt; do not convert them to JavaScript Number. WebSocket snapshot/reconnect transport remains ticket14.

An SQLite write failure returns `503 STORAGE_UNAVAILABLE` and prevents new durable writes until restart/maintenance. Previously committed receipts can still be replayed. A synchronous participant or result/event validation failure rolls back the command. macOS acceptance includes a real OS file-size limit that makes SQLite writes fail: queries and event inspection retain only earlier accepted commands, the failed ID has no receipt, and restarting allows that ID to be retried safely. This test uses `python3` to apply the operating-system limit; it adds no product fault-injection route.

This ticket implements directory registration and browsing among registrations. File I/O, Git, Sessions, Runs, Claims, reclamation, snapshot/reconnect, Linux deployment and backup/upgrade acceptance belong to their later tickets. Directory facts must be revalidated by future file/Run owners immediately before use; registration is not an OS sandbox or a write Claim.
