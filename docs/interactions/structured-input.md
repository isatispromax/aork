# Structured work input

Runtime supports native `elicitation/create` from the installed **ACP SDK 2.7.0 stable v1** default entrypoint. This is not a v2 draft or an invented upstream extension. During `initialize` Aork advertises exactly `clientCapabilities: { elicitation: { form: {} } }`. Native negotiation is a Client advertisement; ACP does not require an Agent `elicitation: true` flag. A peer may use a form only after seeing this advertisement. A peer that asks an ordinary textual question creates no Interaction.

Primary protocol evidence: [v1 elicitation](https://agentclientprotocol.com/protocol/v1/elicitation), [v1 extensibility](https://agentclientprotocol.com/protocol/v1/extensibility), and the installed package's `dist/v1/stable/acp.d.ts`, `schema/v1/schema.json` and `MIGRATION_STABLE_UNSTABLE.md`. The stable declaration exposes `methods.client.elicitation.create` and `CreateElicitationRequest/Response`; no custom namespace is necessary.

## Supported request and response

The request must have explicit `mode: "form"`, the **current native Session** ID, a nonempty `message` up to 500 UTF-16 units, optional `toolCallId` up to 200 units, and `requestedSchema`. Runtime derives Project Session, Run, generation, Host epoch, active Turn and Provider from the actual owned connection. Work forms are accepted only during an active Turn. A request's native Session ID never establishes ownership by itself.

The supported schema is a strict subset, not a general JSON Schema interpreter:

- An explicit root `type: "object"`, 1–16 flat properties, and optional `required` containing unique offered property names.
- Property names contain 1–80 UTF-16 units; `__proto__`, `constructor` and `prototype` are excluded.
- String, finite number, integer and boolean controls, with optional type-correct defaults. Strings support `minLength`/`maxLength` between 0 and 2,000 Unicode code points, and a unique 1–16 value `enum` (each value at most 200 UTF-16 units). The implicit string bound is 2,000 code points.
- Numbers support inclusive `minimum`/`maximum`. Inconsistent ranges, required names or invalid defaults are rejected. Titles are bounded to 200 UTF-16 units and descriptions to 500.
- Optional/null values follow ACP's omission convention. Only empty/null `_meta` is supported. Other unknown keys, regex `pattern`, `format`, `oneOf`, arrays, nested objects, references and schema loading are unsupported; no constraint is silently dropped into a supposedly valid control.
- A complete durable request fact is at most 24,000 UTF-8 bytes. Accepted content is at most 16 offered scalar properties and 48,000 serialized UTF-8 bytes. This keeps the response below the existing 64 KiB HTTP envelope limit. The browser applies the same aggregate and field constraints before submitting.

The native response is `{ action: "accept", content: {...} }`, `{ action: "decline" }`, or `{ action: "cancel" }`. Decline and cancel carry no content. They are explicit user actions, not Turn cancellation or timeout approval.

The native handler uses the SDK's public parser overload for the same native method, retaining raw keys until the strict subset check. The standard SDK parser can otherwise discard unknown constraints. All requests and all response writes still pass through the existing outer bounded ingress: 1 MiB physical messages, 64 outstanding requests, 2 MiB aggregate pending request bytes, release only after the actual underlying response write. Unsupported requests do not get a separate responder path.

## Public command, queries and UI

`@aork/contracts/structured-input` exports version 1 schemas, types and the bounded browser validator. Authenticated `interactions.inputPending`/`interactions.inputHistory` queries and consistent snapshots are separate from the version 1 permission queries. Snapshots accept an optional UUID `sessionId`, filter the authenticated principal first, and return at most 32 forms, keeping pending/responding ahead of terminal history. `truncated: true` marks omitted forms. The bounded `interactions.inputDetail?id=...` resource reads a single owned form.

`interactions.submit` version 1 accepts only `{ interactionId, action, content? }`. Browser-supplied source, owner, generation, process, key, native Session or request identity is rejected. Field validation errors leave the request pending and editable. The pending→responding CAS, Runtime intent, event and immutable receipt commit together. Reusing the same command ID and exact payload returns the accepted receipt; changed content conflicts. Distinct browser commands compete for one claim.

Runtime revalidates the real current Run/Turn, generation, epoch, native Session, typed request ID, exact live channel, admission gate, response type and original field constraints before dispatch and again immediately before the actual writer. The public result/event contains selected action, not submitted content. Actual writer completion yields `responded` and the UI says **已发送响应**; this does not assert Agent progress. Cancel, stop, protocol abort, old generation and Host restart reuse the [permission channel lifecycle](./permissions.md). A selected response with uncertain delivery remains `delivery_unknown` and is never resent or reopened automatically.

Default Session Detail composes `aork.interactions.input-cards@1`; those cards compose the profile-selected `aork.interactions.form@1`. Both are explicit versioned providers. An independent installed archive can replace the form while the default cards and default parent Session remain selected. It uses the same public snapshots/command and cannot alter server constraints, capabilities, claim or invalidation rules. Existing `aork.interactions.cards@1`, `aork.interactions.permission@1`, permission schemas, `interactions.respond` v1 and permission history remain permission-only and compatible. Runtime's added input service members are optional so an older Runtime implementation retains its permission surface.

Snapshot errors retain previously read fields while disabling fresh submission until an authoritative read recovers. An uncertain HTTP attempt retains its original command ID even after a newer snapshot closes the pending form. Reload reads the durable channel state and never creates a new response intent.

## Unsupported and sensitive workflows

Aork does **not** advertise URL mode. URL, unknown mode/schema/constraint or request-scoped setup/auth elicitation receives a generic bounded JSON-RPC `-32602` diagnostic. During a live Turn a separate non-Interaction capability diagnostic is saved at most once per Run; history exposes only the last eight owned diagnostics. It contains fixed text and owned scope, never the raw message, URL, credentials, schema or metadata. The diagnostic does not create a pending form. Unknown extension methods keep the SDK's bounded method-not-found behavior. Ordinary questions remain normal chat.

Forms collect non-sensitive work information. They are not an authentication flow. ACP requires Agents not to request passwords, API/access/refresh tokens, private/recovery keys, transaction authorization or payment credentials through a form. Aork rejects the URL/setup/auth protocol shapes rather than presenting them as saved work forms; it does not infer whether arbitrary natural-language field labels or values are secret. Users review and edit data and see a non-sensitive-data notice before submission. Submitted work content is durably held for the accepted intent/command receipt but omitted from public Interaction events. A future URL/auth flow requires its own consent and privacy design.

## Acceptance boundary

Local acceptance uses actual macOS Host, installed plugins, SQLite, HTTP/event transport, managed Agent processes, native ACP wire logs, independent browser contexts and an independently built/installed form archive. Only the external ACP peer behavior and disconnect/write-pipe faults are controlled. Supported form peers, ordinary non-eliciting peers, unknown schemas and URL requests are exercised separately. Real Claude/Codex capability support and Linux/remote operation remain their actual Provider acceptance work; these controlled peers do not establish those outcomes.
