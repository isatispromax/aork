# Context Handoff and Artifact Reuse

Status: implemented for ticket 27 (2026-11-20)
Owner: `sessions` (linkage, handoff, input capture) together with `artifacts` (version reads, controlled references)

## Linked handoff Sessions

`sessions.createLinked` is a durable command that creates a **new** Session with an explicit `linkedFrom` source reference and an immutable handoff record. It exists so work can continue from existing results or from history that cannot be natively recovered (including a stopped Session on a Provider without native session loading, or an archived Session), without fabricating native recovery.

Boundaries that the command and UI maintain:

- Only user-selected content travels: a summary text, up to four workspace files and/or artifact versions. Nothing is inferred from history.
- The source Session, its inputs, Interactions, interruption records and artifact associations stay untouched and readable. Linkage is visible in both directions: the new Session reports `linkedFrom`, the source reports `linkedTo` successors through `sessions.overview`.
- No native session identity is copied across Providers. The linked Session starts from its own first Run and its own `session/new`; `session/load` never appears for a handoff. The UI states that this is not native recovery and not lossless context migration.
- Files carried across Workspaces are copied at handoff creation to a deterministic controlled path (`.aork-handoff-<hash>-<name>`) inside the target Workspace, through the ordinary Workspace write rules: a held or blocked Claim refuses the copy with a correctable error, and a retried identical handoff verifies the existing bytes instead of duplicating them.
- Carried artifact versions are resolved through the owner seam the artifacts plugin registers on `aork.sessions@1` (`registerArtifactVersions`). Unknown versions, external-reference versions and a disabled artifacts capability are correctable errors before anything is created.
- Command retry is idempotent: the same commandId returns the original receipt and creates no second Session. A different payload with the same commandId is a conflict.

The handoff record stays `pending` until the user explicitly sends it. `sessions.sendHandoff` is a durable command that captures the stored selection as the new Session's first input once its Run is `ready`, under that Run's negotiated capabilities and the usual inline byte limits, and marks the record `sent` with its Turn in the same transaction. Failures (unsupported capability, oversized content, format mismatch) leave the record `pending` with a correctable error and send nothing.

## Artifact versions as input

`sessions.sendText` attachments may now reference a registered artifact version (`{artifactVersionId, kind}`) in addition to workspace files. At acceptance the sessions owner reads the immutable version bytes through the registered artifacts seam, verifies the sha256 against the registered checksum, and captures the content exactly like a file attachment. Version ownership scopes access; external-reference versions carry no bytes and are rejected with a correctable error.

Large content is handled through **controlled references**, never silent truncation: content beyond the inline limits is rejected for inlining, and `artifacts.exposeVersion` materializes the immutable version bytes at a deterministic Workspace path (`.aork-artifact-<artifact>-<version>-<name>`) when no Run holds the Workspace. Re-exposure verifies identical bytes idempotently; a held Claim refuses with `WORKSPACE_WRITE_BUSY`. The reference is the workspace path, which the Agent can read with its own file access.

## Verification

`tests/context-handoff.test.ts` (8 tests) covers linkage and source integrity, carry resolution and error matrix, single-delivery handoff with fresh native session and no `session/load`, cross-Workspace copies, capability rejections, artifact-version input and its error matrix, and controlled exposure. `tests/browser/context-handoff.spec.ts` (2 tests) verifies same-Session artifact reuse through the composer, the provider-switch handoff from a Provider without native loading (including a stale file reference corrected in the dialog), and both-direction linkage in the browser.
