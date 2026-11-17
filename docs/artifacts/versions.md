# Artifact versions

An Artifact exists only through explicit registration. `artifacts.register` is a durable command: the user chooses a Project, an optional existing Artifact (new version), a title and exactly one source. Directory listings, Agent tool reports and workspace writes never register anything automatically, and registration never claims Agent authorship.

A version's provenance is `registered-by-user`. An optional `{sessionId, turnId}` association is validated by Sessions (`SESSION_SOURCE_UNAVAILABLE` for an unknown, foreign or removed Turn) and must belong to the capture Project; a captured-file source must also belong to the same Project and Workspace (`ARTIFACT_PROJECT_MISMATCH`, `ARTIFACT_SOURCE_MISMATCH`). The association records an explicit user choice; it does not prove the Agent produced the bytes. Server-side ownership is checked on every read; the principal is never trusted from the payload.

## Immutable content and external references

`captured-file` sources copy the selected workspace file into artifacts' private content store at registration time. Later reads use the `versionId` only; mutating, moving or deleting the workspace file never changes a recorded version. Each version records `{contentId, sha256, size, filename}` plus the capture coordinates `{workspaceId, relativePath}`. Adding a version never edits an older row or an older content object; distinct command IDs may intentionally create distinct versions, one command ID may not (`COMMAND_ID_CONFLICT` on changed content).

`external-reference` sources record a credential-free `http:`/`https:` URL and optional label as explicit mutable-outside metadata. The Host stores no remote bytes, performs no fetch, redirect following, embedding or URL resolution, and promises no checksum, availability or stability. Download of an external reference fails with `ARTIFACT_EXTERNAL_REFERENCE`; the UI offers an explicit `noopener noreferrer` link instead.

## Publication and recovery

Captured bytes are published under `<dataDir>/plugin-state/artifacts/content/<contentId>/` before any database row exists: a private `0700` directory tree is verified against replacement and symlinks, bytes are written to a `staged` file (`0600`, `O_NOFOLLOW`, `O_EXCL`), fsynced, re-read and checksum-verified, then atomically renamed to `bytes` and the directory synced. Only then does the metadata transaction assign the ordinal and record the version, artifact and receipt together with the `artifacts.versionRegistered` event.

This is deliberately not one atomic filesystem-plus-SQLite transaction. If validation or the metadata commit fails, the command fails visibly (no receipt, no event, no version row) and freshly published-but-unreferenced bytes are removed. If storage itself failed (`STORAGE_UNAVAILABLE`), removal is intentionally skipped because the commit outcome cannot be proven from the public surface; the object stays as a collectable orphan. `artifacts.collectOrphans` pages the content store, removes exactly the objects no recorded version references (all versions, including archived artifacts and archived history, are retention roots) and reports `{scanned, removed, retained, next}`; `artifacts.maintenance` surfaces any cleanup diagnostic. A registration retried after recovery with the same command ID either returns the committed receipt or registers cleanly; it never duplicates a half-written version.

Archiving (`artifacts.archive`) only marks the Artifact. Versions, bytes, provenance and downloads remain readable and remain retention roots for the collector; registering a further version onto an archived Artifact is rejected.

## Public reads and replaceable views

`artifacts.detail` / `artifacts.list` snapshots and resources return owner-scoped pages (25 rows, bounded JSON byte budgets): identity, selected version, version stubs, provenance and content metadata. `GET /api/resources/artifacts.file?versionId=` streams the exact captured bytes (`application/octet-stream`, 8 MiB capture limit) for any format. `GET /api/resources/artifacts.preview?versionId=` returns `{status:'text'|'unsupported'|'too-large'|'external-reference'}`: UTF-8 text up to 256 KiB is inlined; unknown or binary formats keep full file information (filename, size, SHA-256, source) and the download path. All reads require an authenticated identity; snapshots additionally bind to the current plugin graph.

`aork.artifacts.registration@1`, `list@1`, `versions@1` and `preview@1` are separate selected views composed by the workbench menu context. An independently built and installed UI archive replaces all four through the same public commands, snapshots and resources; selection is Project-scoped in the URL and preserves unrelated keys. Active-content rendering isolation is ticket 26 scope; this ticket previews captured bytes as inert text.

## Verification boundary

Real local Node 24.22.3 Hosts, installed Plugins, SQLite, the public HTTP surface and Chromium cover explicit capture, immutable ordered versions with provenance, idempotent retry and payload conflict across restart, denial of foreign owner/Project/Workspace/Session sources, external-reference validation without server fetch, unknown/oversized formats with file information and authorized download, archive retention, and a real competing SQLite write lock taken after publication forcing a visible `STORAGE_UNAVAILABLE` whose orphan the collector later reclaims. Storage races are injected at actual filesystem boundaries of the real Host. This is not real Claude/Codex, Linux deployment, backup/restore or MCP tool registration acceptance.
