# Workspace files

Ticket08 adds the public `WorkspaceService.files` contract and the replaceable `aork.workspace.files@1` view. The workspace browser composes that child view; a different layout or file view uses the same authenticated server interfaces. The Host and transport contain no Workspace paths, schemas or business rules.

Select an open Workspace to browse directories, search filenames, preview numbered UTF-8 source, upload a local file, download bytes, create an empty text file and edit text. The URL fragment retains the selected directory, file and preview page across reload. File browsing neither registers Artifacts nor attributes existing files to an Agent. The default view displays source text, including HTML; it never runs uploaded content.

## Public interfaces

`@aork/contracts/workspace` exports `WorkspaceFileService`, result types, `FILE_LIMITS` and `WORKSPACE_FILES`. Trusted server Plugins obtain `WorkspaceService` through the declared `aork.workspace@1` dependency. Browser Plugins use the generic `runtime.resource(name, parameters, bytes?)`: an omitted body reads; a supplied `Uint8Array`, including an empty array, explicitly writes. It never retries a write. Access loss aborts outstanding resources and rejects results from an old authentication generation.

The HTTP resource route is `GET` or `POST /api/resources/<name>?workspaceId=<stable-id>&...`. Parameters must be single bounded strings. All reads require the signed browser Cookie; writes also require the canonical Origin, CSRF header, current `X-Aork-Graph` and `Content-Type: application/octet-stream`. A supplied stale read graph is rejected too. Plugins receive only parameters, bytes and SDK request context, not a Fastify request/reply or driver.

| Resource | Method and parameters | Result |
| --- | --- | --- |
| `workspace.files` | GET, `path` (empty for root) | JSON directory entries and `truncated` |
| `workspace.search` | GET, `query` | JSON filename/path matches, `visited`, `truncated` |
| `workspace.preview` | GET, `path`, optional `startLine`/`lines` | JSON source, line numbers, revision and editability |
| `workspace.file` | GET, `path` | Original download bytes |
| `workspace.file` | POST, `path` | Create-only upload; JSON path, size and revision |
| `workspace.text` | POST, `path`, optional `expectedRevision` | UTF-8 write; JSON path, size and revision |

Downloads always use `application/octet-stream`, attachment disposition, `nosniff` and sandbox CSP. Unknown formats can be downloaded. JSON metadata/previews have sandbox CSP too. The default UI creates download Blobs with the same binary MIME; active HTML is escaped React text, never an iframe or workbench-origin document.

The transfer limit is 8 MiB. Text read/write is limited to 256 KiB, with 1–500 lines per preview and a positive start line. A partial preview is not editable in the default UI. Text rejects invalid UTF-8 and NUL and preserves an existing UTF-8 byte-order mark. Directory listing returns at most 500 entries; search visits at most 5,000 entries, returns at most 200 matches and descends at most 32 levels. Both bound encoded entry data to 750 KiB and report truncation. Directory handles are read incrementally and closed. Search matches names/relative paths, not file contents.

Missing paths, permissions, read-only access, changed directories, invalid paths, binary previews, oversize data and stale editor revisions have explicit errors. Upload never overwrites an existing file. The editor sends the preview's SHA-256 revision, so an externally changed or deleted original returns `WORKSPACE_FILE_CHANGED`. File state is visible after refresh and Host restart through the actual directory.

## Directory and write boundaries

Each operation resolves the saved requested root again and verifies the actual root, recursive scope, directory kind, device/inode and applicable server access. A moved, replaced or retargeted registered root is refused. Paths are relative with no absolute, parent, dot, empty, backslash or NUL components. All symlinks below the registered root are rejected, including aliases pointing back inside it. The root's originally authorized alias is usable only while it identifies the same saved actual directory. Regular reads use a no-follow descriptor and verify file identity and content facts before returning data. Special files are not read or written.

Every write goes through the single workspace-owned `withWritePermission(id, operation)` entry. It validates the open Project/Workspace and read-write root, checks authoritative writer status, and holds an in-memory canonical directory reservation across the entire awaited operation. Same-root and ancestor/descendant reservations conflict even when registered as different Workspaces. The permit is released only when the operation resolves/rejects; it has no expiry timer.

Ticket11 must register a synchronous `WorkspaceWriterParticipant` before starting any managed writers and use the same `withWritePermission` gate around real Claim acquisition. Its `inspect(workspace)` must inspect all overlapping authoritative claims, returning `unclaimed`, `blocked` or `unknown`; pending cancellation and unconfirmed termination must remain blocked/unknown. Before any lifecycle participant is installed, this slice explicitly knows that it has no managed-writer subsystem. Once a participant registers, a missing, throwing, invalid or disposed authority is unknown and denies writes. The interface does not fabricate a Run, durable Claim or TTL release. Claim reservation must hold this same in-flight gate around its short synchronous transaction. Run/MCP use will also need server-authenticated ownership context, so GUI writes deny a Run Claim while the authorized owning Run can use its own Claim. A browser-supplied Run ID must never act as that authority. Ticket11 may extend this provisional contract when real Run/Claim acquisition and tools use it. Ticket08's installed participant test verifies the public integration seam and an actual held asynchronous writer, not Run/process safety; actual Run/Claim recovery and stop verification remain ticket11.

Writes create a mode-0600 temporary regular file in the destination directory, write and synchronize its bytes, revalidate the registered path, then rename into place. Failure before replacement does not publish a success result and attempts to remove the temporary file. This is a filesystem operation, not an SQLite transaction: it creates no durable command receipt, event, Artifact or Agent attribution. A process failure after the filesystem change can leave the caller uncertain; clients must inspect the file rather than assume an automatic retry is safe. Filesystem failures do not create false database success. Replacing a text file creates a new inode with mode0600; other metadata is not preserved.

These checks coordinate trusted Aork writers and ordinary filesystem access. They do not prevent external programs from changing directories and do not provide an OS sandbox against a malicious same-user process racing path operations. Run/Claim safety, MCP authorization, Artifact registration, Git, Linux/remote deployment and backup/restore acceptance remain their own tickets.
