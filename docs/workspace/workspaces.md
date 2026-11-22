# Workspaces

The default `workspace` Plugin supplies Workspace data, the server browse resource, file services and the replaceable `aork.workspace.browser@1` view. The default workbench mounts those child contracts: `aork.workspace.navigation@1` is the left region's Workspace section (it lists Workspaces only, never the nested Session list), while the Files view is contributed as a right-region section through `aork.workbench.inspector-sections@1`. The single-level Workspace list, create/edit/archive dialogs, directory picker and directory details belong to this Plugin; the Host has no Workspace imports.

A Workspace is the only top-level organizational unit. Every Workspace binds one real directory on the server: creating one always registers an existing absolute directory readable and writable by the server, covering that directory and its descendants. The former managed mode that created a fresh directory below the instance's `workspaces` directory is removed. The server resolves the canonical path with `realpath` and records both the requested path and the resolved directory, so an alias such as a symlinked path keeps its original spelling while all checks run against the real directory and its device/inode identity. A directory need not contain Git metadata. Workspace IDs are stable UUIDs and remain stable when names change.

## Directory picker

Workspace creation uses the in-app directory picker: a self-drawn macOS-style window over the `workspace.browseDirectory` resource. The window chrome follows NSOpenPanel — a title bar whose close light cancels, a toolbar with Finder-style back/forward history and a live search field that filters the current listing client-side, a 收藏 sidebar (主目录/桌面/文稿/下载 with icons), a bottom path bar with clickable segments and an item count, and 取消/选择 action buttons. 「前往文件夹」 accepts an absolute path or a `~`-prefixed path (`~name` passes through and is rejected in place); the server never accepts `~` or relative paths, so the picker expands `~` client-side using the `home` field of the browse response. ⇧⌘G (Ctrl⇧G off macOS) moves focus to the input; this is the only way into hidden directories while dotfiles are hidden. Each Finder-style column shows one directory, with folders before files and links. Clicking a folder opens another column to its right and preserves the selections in earlier columns. ↑ and ↓ move the selection within a column, and ← and → move focus between columns. The search field filters the rightmost column. 「选择」 confirms the directory shown in the rightmost column and is disabled while a file or link is selected. Esc closes the picker. Confirming suggests the directory's basename as the Workspace name when the name field is empty. Listing beyond the 500-entry cap shows a truncation notice pointing at 「前往文件夹」. Creating folders inside the picker is not available in this version.

`workspace.browseDirectory` is a deliberately scoped server exposure: a single-level, browse-only metadata listing (`name`, `path`, `kind: directory|file|symlink|other`, `size`). It never reads file contents, never follows symlinks into subtrees, truncates at `FILE_LIMITS.entries` (500) and the shared 750 KiB encoded budget with `truncated: true`, and reports missing/not-a-directory/broken-link and permission failures as in-place errors (`WORKSPACE_BROWSE_DIRECTORY_INVALID`, `WORKSPACE_BROWSE_DIRECTORY_DENIED`) without leaking system details. Authorization is the existing login boundary (signed Cookie; commands/CSRF rules unchanged). All other filesystem access remains locked inside registered Workspaces' device/inode boundaries.

## Public commands and queries

All business HTTP routes require the existing signed browser Cookie. Commands also require the canonical Origin, the Cookie's CSRF header and the current plugin graph hash.

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
| `workspace.create` | `{workspace: {name, directory:"/absolute/path"}}` |
| `workspace.edit` | `{id, name}` |
| `workspace.archive` | `{id}` |

Public schemas live in `@aork/contracts/workspace`; unknown payload fields are rejected. `workspace.create` verifies existence, directory kind and server read-write permission before the database transaction and returns `WORKSPACE_DIRECTORY_INVALID` otherwise. `workspace.edit` revalidates the recorded requested path against the resolved directory and its device/inode before applying the new name; a moved or replaced directory is refused. `workspace.archive` keeps the registration record and files. Archived Workspaces reject edits and new Session/Run use; “显示归档” exposes the retained records. `GET /api/queries/workspace.overview` returns authoritative Workspaces, including archived registrations. Events are `workspace.created`, `workspace.edited` and `workspace.archived` (version 1). `PROJECT_UNAVAILABLE` and the project commands/events are removed; Workspace availability errors use `WORKSPACE_UNAVAILABLE`.

Success returns an immutable `{commandId, name, version, outcome:"completed", result, committedAt, events:[{id,seq}]}` receipt. The receipt is also available at `GET /api/receipts/<commandId>` to the same authenticated instance principal. Signing-key rotation/recovery preserves that principal, so accepted commands remain deduplicated after obtaining a new Cookie.

The fingerprint covers command name, command version and the original parsed JSON payload with object keys sorted. Arrays and values retain their meaning; trimming a display name or adding an explicit default is a different payload even if its normalized business value would match. The same principal and ID with changed content returns `409 COMMAND_ID_CONFLICT`. The original receipt is returned before touching directories on a retry, even after the directory disappears or the entity is edited. Authentication, CSRF, Origin and graph checks still precede receipt replay.

The browser stores entity selection in its URL fragment via `readWorkbenchSelection`/`withWorkbenchSelection` (`workspace`, `session`, `createSession=1`, plus `directory`, `file`, `line` and artifact keys) and restores it on reload. The `project` and `artifactProject` keys are removed; whenever the actual Workspace identity changes, the helper clears the relative Files and artifact selection.

## Persistence and event inspection

One locked Host opens the only SQLite connection, with WAL, foreign keys, 5000ms busy timeout and FULL synchronization. The workspace Plugin owns its schema, foreign key, migration checksum and private Drizzle statement compiler. SDK repository bindings expose only declared owner-scoped read statements and writes requiring a live opaque synchronous transaction. No driver or Drizzle object enters the SDK or browser bundle. A live token may be passed through an explicit semantic service for a later cross-Plugin transaction; cached or other-instance tokens are rejected.

**Upgrading requires clearing the data directory.** There is no data migration: the historical migration declarations were rewritten in place (the `projects` table and the `project_id` column/index are gone; Workspaces store id plus record JSON, plus the Run Claims table). The migration runner's checksum check makes an existing database refuse to start; existing data directories are void and must be emptied and rebuilt. Project IDs embedded in Session and Workbench record JSON are voided with the rebuild and never read compatibly. Externally registered directory paths do not survive, so back up the paths you want to keep and re-register them through the directory picker after rebuilding.

Directory preparation and validation run before the database transaction. Domain changes, runtime-schema-validated result, sanitized browser event and successful receipt commit together in one short synchronous transaction. A failed validation or transaction has no visible partial entity, success event or receipt. External directories are never removed as rollback. There is no claim that filesystem and SQLite commits are atomic.

`GET /api/events?after=0&limit=100` is an authenticated bounded inspection API. It returns only this principal's sanitized browser events. `after` must be a canonical nonnegative decimal string up to SQLite's signed 64-bit maximum; `limit` is 1–100. Event IDs and decimal string sequences persist across restart. Keep sequences as strings/BigInt; do not convert them to JavaScript Number. WebSocket snapshot/reconnect transport remains ticket14.

An SQLite write failure returns `503 STORAGE_UNAVAILABLE` and prevents new durable writes until restart/maintenance. Previously committed receipts can still be replayed. A synchronous participant or result/event validation failure rolls back the command.

Ticket08 adds [file operations](files.md), revalidates directory facts before use and supplies the shared write-permission entry. Ticket10 adds [Sessions and retained history](../sessions/history.md), with Workspace-owned directory inspection that also preserves archived or missing-directory history. Git, Runs, Claims, reclamation, snapshot/reconnect, Linux deployment and backup/upgrade acceptance remain later tickets. Registration and file permission are not an OS sandbox or proof that a Run stopped.
