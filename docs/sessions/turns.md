# Text Turns, streamed history and cancellation

The `sessions` Plugin owns accepted input, Turns, user/Agent timeline and display-only tool reports. `runtime-acp` owns ACP requests, operation intents, durable facts and live response channels. `interactions` owns the pending permission projection. All three use public SDK services and owner repositories; no Plugin reads another Plugin's SQL or stores a native deferred/context in SQLite.

## Public interfaces

| Interface | Behavior |
| --- | --- |
| `sessions.sendText` | Authenticated durable command `{sessionId,text}`. Returns the original accepted Turn receipt; it does not claim the Agent completed or received the prompt. |
| `sessions.cancelTurn` | Authenticated durable command `{turnId}`. An accepted, undispatched input can be cancelled immediately. A dispatched Turn becomes cancelling until its actual terminal outcome. |
| `sessions.overview` / `sessions.detail` | Session execution, latest `currentTurn` and persistent `dispatchPaused`. |
| `GET /api/resources/sessions.timeline?sessionId=<uuid>` | Authorized bounded Turn/message/tool history, including archived Sessions. `truncated` explicitly reports a shortened view; persisted history is not deleted. |
| `GET /api/queries/interactions.pending` | This principal's currently valid pending permission requests, correlated by Session, Run, generation, Turn, native Session and typed request ID. |

Send/cancel use the existing Origin, Cookie, CSRF, current graph and versioned command envelope. Identical principal/command ID/content returns the same immutable receipt before current busy/reference checks, including after completion. Changed content conflicts. User whitespace and Unicode are content; trim only determines whether input is empty. Input is limited to 16,000 UTF-8 bytes and 24,000 serialized JSON string bytes, leaving durable event headroom. Invalid input leaves no receipt or partial message.

A single short transaction stores accepted Turn, user message, event and receipt. A separate short transaction admits a Runtime prompt intent and moves the Turn to dispatching. Runtime rechecks the current Run and stop intent, commits attempting, then issues the actual ACP `session/prompt`. Only one Turn reserves a Session: another distinct input receives HTTP409, including while waiting/cancelling. This ticket does not add queue management or automatic resume.

## Durable streaming and bounds

SDK notification callbacks are concurrent. Runtime places attributable message/tool/permission progress and the definitive prompt outcome on one per-Run persistence lane. Neither the prompt lifetime nor a permission deferred occupies that lane or Run control. Facts commit before Sessions applies its projection, browser event and consumer offset in one transaction. Late/stale native Session or generation updates cannot select an arbitrary Session.

Text splits at codepoint boundaries, with at most 4,000 UTF-16 code units and approximately 8,000 serialized bytes per fact. Pending ingestion is bounded by 256 frames and 256KiB of charged serialized work. Overflow closes/stops the affected managed Run; unrelated Runs remain usable. The ACP frame limit is 1MiB. The timeline response stays below 900,000 serialized bytes (transport limit1MiB), includes at most50 recent Turns/1,000 messages/200 tools, and trims all collections as needed with `truncated:true`.

Tool calls/patches update a bounded display keyed by native tool ID; text content is bounded and other content gets a safe placeholder. Reports never invoke tools. Raw input/output, `_meta`, Agent thoughts and native error data are not projected. `usage_update` is reported context used/size and optional session cost, not an invented per-Turn token bill. Absent usage/cost is unknown. A definitive native RPC error becomes failed with a code-only reason, distinct from uncertain transport loss.

## Permission response channels and cancellation

A reliable ACP permission request creates a live generation-bound response channel and a durable Interactions projection. Ordinary Agent questions do not create pending work. This slice has no allow/deny/respond command, automatic approval or approval timeout. Requests must fit their schema and a24KiB serialized fact budget before registration. Unsupported/oversized, duplicate or excess channels close their affected connection and use managed stop; they cannot poison terminal persistence. At most16 permission channels remain live.

A public ACP Stream wrapper also bounds **all** incoming RPC requests, including unknown methods, rejected/stale requests and SDK-held responses. It charges typed request IDs and serialized bytes before SDK dispatch (64 pending requests/2MiB), and releases only after the underlying response write completes. Duplicate/malformed requests and overload synchronously close that connection before further responses are queued, then stop the owned process. These are pending-write limits rather than lifetime request counts.

Cancel acceptance persists cancelling and its Runtime control intent. Runtime closes new response admission, invalidates/settles existing channels as native cancelled, persists invalidation, then sends semantic `session/cancel`. Notification completion or a local abort is not stop proof. A cooperative original prompt response with stopReason cancelled ends the Turn while preserving ready Run and held Claim. A definitive completion winning the race retains its actual stopReason. If1.5s grace expires, the existing Runner confirms managed stop; the Turn retains that fallback reason and never fabricates an ACP cancelled stopReason.

End Run/shutdown closes channels first, closes ACP and joins prompt/ingestion separately from process-group/job supervision. Fresh Runtime-owned cleanup retries retained invalidations/terminal outcomes when an ordinary or dependent cleanup scope cannot write. Only confirmed Run stop releases a Workspace Claim. Browser disconnect remains observation-only.

## Loss, restart and validation

An attempted prompt with no durable attributable Agent progress or definitive response becomes delivery_unknown on transport loss. Durable text/tool/permission progress followed by lost connection becomes interrupted. No uncertain input is automatically replayed. Critical persistence failure closes intake and stops or blocks affected execution; memory-only output is never presented as saved.

Restart fences old epochs, invalidates old channels and pauses unfinished Session dispatch. Accepted text remains retained. Runtime uses persisted attempting/progress evidence; when Runtime is disabled, Sessions conservatively uses its own durable progress projection to distinguish uncertain delivery from known interruption. Old PIDs are never used as new stop authority. There is no resume/force-release UI in this slice.

The default Detail composes independently selected `aork.sessions.composer@1`, `aork.sessions.messages@1` and `aork.sessions.tools@1` providers. The composer guards IME Enter, supports Shift+Enter, retains draft plus original uncertain command ID across browser reload, and follows authoritative states. Public polling is used until the event-transport ticket; no timer guesses completion. An independently packaged UI replaces all three against a fixed Host build and the same public service constraints.

Acceptance is local macOS with actual Node24.22.3, built Plugins, Runner processes, SQLite, HTTP/events/local maintenance and Chromium. Only the external ACP Agent/timing/fault process is controlled. This is not real Claude/Codex, Linux, remote deployment, native recovery, MCP execution or structured-input acceptance.
