# Sessions and retained history

The `sessions` Plugin owns Session identity, saved environment selection, history index and archival. A Session is distinct from a Runtime Run and a Turn. Creating one does not start a process, send an ACP prompt, acquire a Workspace Claim or manufacture conversation history. The default distribution has no real Agent Provider and seeds no Projects, Profiles or Sessions.

Choose a Project and one of its open Workspaces, then a saved Agent Profile. The form displays the actual canonical server directory and registered Agent label. An empty Profile list links conceptually to Settings → Agent; no fictional default Agent is selected. Availability checks in Agent Settings describe configuration readiness, not verified remote authentication.

## Public behavior

| Interface | Behavior |
| --- | --- |
| `sessions.create` durable command | `{name, projectId, workspaceId, profileId}` creates one stable Session UUID; rejects mismatched Workspace/Project, archived environment, unavailable Profile/Provider and unknown fields. |
| `sessions.archive` durable command | `{id}` retains configuration and Workspace associations; never stops a Run or releases a Claim. |
| `GET /api/queries/sessions.overview` | Lists this authenticated principal's open and archived Sessions, saved configuration selection, directory availability and truthful execution/native-history state. |
| `GET /api/resources/sessions.detail?id=<uuid>` | Retrieves the same authorized history projection for one Session; missing/inaccessible IDs return 404, malformed input 400. |
| `aork.sessions@1` server service | Trusted semantic `getSession`, `requireOpenSession` and explicit archive-policy registration; no table or driver crosses ownership. |

Commands use the existing versioned HTTP envelope, Origin, CSRF, graph hash and immutable receipt rules. Domain state, sanitized event and receipt commit in the Host's one synchronous transaction. The same principal and command ID with identical wire content returns the original receipt, including after archive, Profile edit, directory deletion or restart. Changed content returns `COMMAND_ID_CONFLICT`. Validation failures leave no Session, accepted receipt or success event. Creation validates Workspace and Profile through their public semantic services inside that transaction.

The saved Profile selection includes its ID, revision, Provider definition version, validated parameters, authentication method and opaque credential reference. It omits native state-directory paths, launch commands, environment and private plugin configuration. Editing a Profile does not rewrite this selection or prior receipts. This selection is not a complete Run launch snapshot; ticket11 must capture and validate the actual immutable launch facts before execution.

History reads use saved identities and snapshots. They do not call a method that requires a physically present, open directory just to retrieve history. Workspace-owned async `inspectDirectory(id)` applies the same canonical path/device/inode/access checks as the file service, including for archived registration. Missing or replaced directories produce a generic unavailable projection while Session history and saved paths remain readable. Directory inspection is an observation, not a writer reservation or permission to start an Agent; future starts must revalidate via Workspace's coordinated write permission.

## Replaceable UI and entity selection

The default Workspace browser composes three independently selected contracts: `aork.sessions.navigation@1`, `aork.sessions.create@1` and `aork.sessions.detail@1`. Their implementations live in the Sessions Plugin, and a separate UI archive can replace all three without changing Host code or Session identity. Files continue to render through `aork.workspace.files@1` alongside selected Session details. No private component imports or React/DOM patches are used.

The public entity URL fragment uses `project`, `workspace`, `session` and `createSession=1`. `readWorkbenchSelection` and `withWorkbenchSelection` in `@aork/contracts/workspace` read and update these keys while preserving unknown keys, including Files selection. Selecting a different Workspace clears the previous Session/file selection; creating a Session in the selected Workspace preserves file context. Incorrect URL associations show a mismatch with an action to open the Session's recorded environment. Reload and restart restore the same Session, including archived history.

Modal drafts remain mounted during subscription refreshes. Native dialogs provide focus containment, Escape cancellation and focus return; IME composition Enter cannot submit creation. A failed create retains the same command ID and content for safe retry. Editing the draft creates a new command identity. A browser acceptance test discards the first response only after the real Host committed, then verifies one Session and the original receipt on retry.

## Archive and execution boundaries

`registerArchiveParticipant({id, assertCanArchive})` registers a synchronous lifecycle authority. Duplicate active stable IDs conflict; disposal retains an unavailable authority and blocks archive until the same ID is registered again. A participant can reject archive in the same transaction without changing Session history. Returning a Promise is rejected. Ticket11 must register the real execution authority before Runs can exist, or integrate equivalent authoritative checks in the Session owner. Archive does not invoke stop, mark a Run terminated, release a Claim or infer process death.

Every current Session truthfully reports `not-started`, and native history explicitly reports `restorable:false` / `never-started`. There are no actual Runs, Turns, ACP prompts, native restoration, Agent-memory reconstruction, linked handoff, queue or message stream in ticket10. Those states must be supplied by their owning later tickets. This work was verified on local macOS; no remote deployment, Linux acceptance, upgrade or backup/restore acceptance is implied.

Verification uses real built Host processes, SQLite, public maintenance/HTTP/browser interfaces and an independently loaded controlled Provider executable that only implements version detection. It does not stand in for real Agent execution. A separately built and publicly installed UI archive verifies navigation, creation and detail replacement against the same Session IDs after restart.
