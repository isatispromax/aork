# Permission Interactions

Interactions owns durable permission cards and one-time response commands. Runtime owns the actual ACP connection, typed request identity, native Session and in-memory response resolver. No persisted record can recreate a closed response channel. Ordinary Agent text, unread replies and elapsed time never create or approve an Interaction.

## Public response

Authenticated clients read `interactions.pending`, `interactions.history` or the bounded `interactions.detail?id=<interactionId>` resource. The corresponding pending/history snapshot endpoints accept an optional UUID `sessionId`. Every result is filtered by authenticated principal before the Session filter. A valid but unrelated Session ID returns no records; the filter does not establish Session ownership or expose another principal's records.

Snapshots share the Host's synchronous owner-read transaction and durable event cursor. History contains at most 32 records, prioritizing pending/responding channels over recent terminal history, with `truncated: true` when records are omitted. A Session's actual live permission channels are bounded separately by Runtime. The bounded global query is not an unbounded cross-project pending index; global aggregation and pagination are a later ticket.

`interactions.respond` version 1 accepts exactly `{ interactionId, optionId }`. The option ID must be offered by that request. Request labels can be clipped for display; opaque option identities are preserved exactly or the entire unsupported request is rejected. Unknown fields, invented options and stale cards never grant permission.

The command atomically changes pending to responding, admits a durable Runtime response intent, emits its event and saves an immutable receipt. A repairable invalid option leaves the request pending. Independent commands in two browsers compete for the same claim; only one succeeds. Retrying the same command ID and exact payload returns the original receipt, including after the final state changes, without another native response. Reusing the ID for changed content conflicts.

Runtime then checks the real Run, generation, Host epoch, current Turn, native Session, typed ACP request ID, exact live handle and open admission. These checks happen outside the database transaction before the effect. The browser supplies none of that authority.

## What the statuses mean

| State | Meaning |
| --- | --- |
| pending | A valid live channel awaits an explicit offered choice. |
| responding | The single response intent was accepted. It is not yet confirmation of a native write. |
| responded | The actual underlying local ACP response write completed. The UI says **已发送响应**. |
| cancelled | Cancellation closed the channel before a selected response could be written. |
| expired | The live channel disappeared or belonged to a previous Host/connection. |
| delivery_unknown | A selected response entered the sending window and definitive delivery could not be established. It is never automatically resent. |

A successful response write does not prove that an Agent applied approval or continued execution. Later Agent progress facts are separate evidence. The existing `invalidated` value remains readable for historical records from the earlier waiting-only slice.

Runtime records attempting before resolving the ACP SDK handler. Handler resolution alone is insufficient: the private stream observer checks the gate again immediately before the underlying writer and observes its actual completion. If a selected result waits behind an earlier blocked write, cancellation can still replace it with a native cancelled outcome. Disconnect after queuing a selection is conservatively uncertain, even when the final writer was not reached. No renderer can extend a channel or bypass this gate.

Cancellation first closes admission to new response channels. Existing channels are invalidated before semantic `session/cancel`. A healthy Run continues to hold its Workspace Claim throughout prompt and permission handling; only confirmed managed Run stop can release it. Browser closure is observation-only. Stop, disconnect, protocol cancellation and Host restart invalidate old cards, and neither prompts nor permission responses are automatically replayed.

## Replaceable UI

The default plugin provides `aork.interactions.cards@1` and `aork.interactions.permission@1`. Cards compose the selected form through the public `runtime.renderView` contract. Both read public owner snapshots and invoke the same response command. The Distribution Profile selects each provider explicitly, so an independently packaged plugin can replace cards and form separately without rebuilding the Host or importing another plugin's implementation.

The form retains an uncertain HTTP attempt's original command ID. Its retry queries or completes that same command even when a fresh snapshot already removed the pending card. A network error retains saved card content while disabling a fresh choice until a successful authoritative snapshot arrives.

## Validation boundary

Acceptance uses actual macOS Hosts, built plugins, Runner processes, SQLite, HTTP/event transport, independent browser contexts and installed UI archives. Only the external ACP Agent behavior, timing and disconnect faults are controlled. This does not establish real Claude/Codex, Linux/remote deployment, real Provider structured input support, MCP execution or native Session recovery.

Native structured work forms use separate additive version 1 contracts and queries; see [Structured work input](./structured-input.md). The permission-only contracts above are unchanged.
