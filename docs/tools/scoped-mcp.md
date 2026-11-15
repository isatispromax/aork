# Scoped Host tools

The default distribution contains `tools` and the independent `workspace-tools` provider. No Artifact plugin is required. A Session starts with an empty selection. Select explicit definition versions in its compact **工作台工具** view and save before starting a Run. Changes apply to the next Run. The public child contract is `aork.tools.selection@1`; replacing it uses the same commands and snapshots.

The Agent receives a real MCP stdio server descriptor during native Session creation. Runtime alone converts the SDK-independent descriptor to ACP. The command is the absolute locked Node executable, the argument is the absolute packaged `bridge.mjs`, and environment uses ACP's name/value array. Each nonempty Run has its own protected local Unix socket and unrelated 32-byte random token. The bridge has no database, browser credentials or Session-authority parameter. Its only authority is that live connection's exact grant. A bridge disconnect ends that grant and stops its Run. There is no reconnect or automatic call replay.

## Public contracts

Providers depend on `@aork/sdk/server` and `@aork/contracts/tools`, declare `aork.tools@1`, then call `registerTool(definition, handler)` on their scoped service. Prefer `context.effect(() => tools.registerTool(...))`. The actual consuming Plugin supplies ownership; an argument containing another valid owner descriptor cannot replace that caller. IDs begin with the actual provider's ID plus a dot. Definitions include an immutable version, bounded JSON Schema, independent argument parser, title, description and descriptive read/write access.

The JSON Schema root is an object, has at most 16 KiB encoded bytes, 512 structural nodes and depth 16. References are unsupported. Both the captured JSON Schema and provider parser validate arguments. Tool results are Aork's text-content subset with optional bounded JSON structured content and `isError`; the locked MCP SDK additionally validates the actual result shape. Exceptions and invalid or oversized results return a safe explicit error, never a fabricated success. Resources, guidance and Agent-native Skills are not implemented by this registration interface.

A handler receives only its AbortSignal, trusted Run/optional Turn, and invocation-scoped `files.preview` / `files.writeText`. It receives no raw Claim authority, token, SQL handle or Runtime context. `workspace-tools.read_text` and `workspace-tools.write_text` use these exact public interfaces. Write supports an optional SHA-256 `expectedRevision`.

| Public boundary | Purpose |
| --- | --- |
| `tools.catalog` query | Bounded live catalog metadata and exact refs; schema bytes are omitted from this global list |
| `tools.definition` resource `{id, definitionVersion}` | One bounded complete current tool definition |
| `tools.replaceSessionSelection` durable command | `{sessionId, expectedRevision, tools}` CAS; future Runs only |
| `tools.session` snapshot/resource `{sessionId, runId?}` | Saved selection, one full immutable Run snapshot (latest by default), bounded compact history |
| `tools.calls` snapshot/resource `{sessionId}` | Latest 100 real Host calls, with large older results explicitly omitted when the aggregate budget requires it |
| `tools.revokeRun` durable command `{runId}` | Commit grant revocation, then stop through the actual Runtime owner |
| `tools.selectionChanged`, `tools.grantChanged`, `tools.callChanged` | Sanitized durable invalidations/records; browser reconnect uses consistent snapshots |

All browser reads and commands require the authenticated principal. Tokens, socket paths and ACP MCP launch descriptors are memory-only and never included in durable operations, call records, receipts, events or browser state. Run summaries contain only exact refs, grant identity and selection revision; full schemas are stored once under Tools and fetched per Run. ACP-reported tool updates remain labeled Agent reports, separate from actual Host calls.

## Claim and stop semantics

Sessions captures selected descriptors and grant intent in the same short transaction as Run and Claim admission. `usedPluginIds` includes Tools and every selected provider before both Claim reservation and Runtime admission. Native IO/spawn happens only after commit. Existing Sessions are explicitly backfilled through the Tools participant with empty selections.

Workspace mints a process-local WeakMap authority only for the selected actual Runtime while the same-TX Claim permit is valid. A permit cannot later serve as lifetime proof. Only the selected actual Tools consumer may derive a file facade. Every file operation rechecks the exact held Claim and live owner, Workspace access, physical root identity, path and overlap. Ordinary browser writes still reject held/blocked Claims. The existing bounded file IO and atomic temp-file publication pipeline is shared by both paths; abort checks precede publication, and write/sync/close/temp cleanup remain awaited. No rollback of already published bytes is promised.

Every admitted tool call registers its real job with the actual ManagedProcess before invocation. Cancellation aborts and joins the actual handler, every started file operation (including a Promise the provider did not await), and finally cleanup. The file facade rejects new work after invocation completion or grant revocation. A retained facade cannot begin a later write. A job is not unregistered merely because abort was requested, the peer closed, or a result waiter disappeared.

Ending Run, public revoke, bridge failure, initialization failure, peer exit and Host close converge on the same revoke/stop path. Runtime invalidates file authority before publishing a terminal fact. Workspace also refuses Claim release while actual admitted Run IO remains outstanding. Runner's existing two-second job acknowledgment bound can produce `unknown`; then Claim stays blocked even if the Agent exited or the job settles later. Late settlement does not automatically reconcile or release it. Restart invalidates old epochs/grants, marks unfinished calls unknown and never replays tools.

Provider liveness is synchronously verified for catalog, capture, open/list and dispatch. Failed activation retires its entries immediately from effective behavior, drops handler/parser references, revokes affected grants and requests stop. Snapshots contain data plus a registration identity, never copied handlers. Nonce-only disposers cannot remove later registrations. A bounded 100 ms scavenger also physically clears stale entries; this interval is not an authorization window.

## Bounds and packaging

There are at most 256 live registrations, 64 per provider and eight selected tools per Run. Private IPC uses length-prefixed strict JSON with a 1 MiB frame limit, a two-second first-frame authentication deadline, at most 16 unauthenticated sockets and one authenticated connection per grant. Arguments have a 320 KiB encoded limit, results 512 KiB, execution four calls per Run / 64 globally, and 32 file operations per invocation. Output buffers are bounded to 64 frames / 1 MiB. Request IDs increase monotonically, so replay/duplicate IDs do not require an unbounded cache. Busy calls fail explicitly.

A 30-second call deadline requests abort and Run stop. It does not establish completion. Private socket parents are created under the real short system `/tmp`, mode 0700; sockets are verified 0600 and paths are capped at 90 bytes. Cleanup touches only that listener's created directory. Stderr uses fixed diagnostics and stdout remains MCP protocol.

The manifest's bounded `executables` array declares additional private prebuilt ESM entries. Entries are distinct from server/client/maintenance/public assets, package-hashed, verified by the installer and never registered as HTTP assets. Both normal distribution and standalone package builds compile `src/<entry base>.ts` to that entry. `new URL('./bridge.mjs', import.meta.url)` works when the loaded server URL has a Host hash query. Acorn 8.15.0 parses actual require calls so inert MCP/AJV code-generation strings do not falsely reject a fully bundled package; real unresolved calls and computed imports remain rejected.

## Verification scope

The implementation uses Node 24.22.3, pnpm 10.30.2, MCP server/client 2.4.0, legacy MCP client 1.32.2, ACP SDK 2.7.0 and Acorn 8.15.0. An isolated real stdio probe exercised modern and legacy MCP handshake/list/call on Node 24. The integrated controlled external ACP Agent launches the exact generated absolute bridge descriptor and a real MCP client against real Host Plugins, SQLite, HTTP and Workspace IO. Independent tool and selector archives install without rebuilding Host.

The fixture-only `mcp-io-preload.mjs` intercepts the built bundle's actual Node FileHandle write for one exact fixture Workspace, calls the saved real operation, records OS markers, and withholds only JavaScript completion until an external release file. It proves admitted filesystem/job/Claim lifetime and cleanup timing. It does not prove a kernel write is blocked or interruptible, rollback, Linux containment or real Claude/Codex compatibility. Mac-first controlled-protocol evidence does not replace those later acceptances.

Primary references checked: [MCP v2 upstream](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/packages/server), [MCP stdio](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio), [Acorn 8.15.0 API](https://github.com/acornjs/acorn/blob/8.15.0/acorn/README.md), [exact Acorn registry metadata](https://registry.npmjs.org/acorn/8.15.0). Installed locked sources and actual execution, rather than documentation examples alone, establish the package API used here.
