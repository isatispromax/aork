# Negotiated Run input and settings

The selected external ACP Agent owns model, mode and configuration choices. A ready Run exposes `negotiated` in the authorized `sessions.overview` / `sessions.detail` snapshot, with a revision, prompt capabilities, optional modes and bounded select/boolean `configOptions`. Model selectors are Agent options with category `model`; Aork does not call an unnegotiated legacy model extension or invent common Claude/Codex model IDs. Missing optional capabilities are false. Opaque ACP metadata and native authentication details are omitted.

## Change the current Run

`sessions.configureRun` is an authenticated, CSRF/Origin/graph protected durable command:

```json
{
  "runId": "<current Run UUID>",
  "generation": 1,
  "expectedRevision": 1,
  "change": { "kind": "option", "configId": "<Agent option ID>", "value": "<Agent value ID>" }
}
```

Modes use `{"kind":"mode","modeId":"<Agent mode ID>"}`. Boolean options use a boolean `value`; the native ACP request includes `type:"boolean"` as required by SDK 2.7.0's stable v1 declaration. IDs and values must belong to the current Run snapshot. A stale generation/revision, active Turn or another pending configuration is rejected before native dispatch.

The receipt records an accepted intent, its original `expectedRevision` and a monotonic Run-local operation `sequence`, not successful configuration. Runtime rechecks the accepted revision, current Run/generation/epoch, live connection and option membership inside the transaction that commits dispatching, immediately before `session/set_config_option` / `session/set_mode`, then publishes applied only on a definitive native response. Returned option sets and `config_option_update` / `current_mode_update` notifications advance the Run revision. A definitive native RPC rejection is failed with a code-only reason. Uncertain transport, a five-second timeout, invalid Agent state or persistence failure stops the affected managed execution; no configuration is automatically resent. Restart reports attempted configuration as delivery_unknown and keeps the Workspace blocked until execution is verified by the existing lifecycle/maintenance rules.

Each accepted Turn saves its full configuration/capability snapshot and immutable `configurationRun` provenance. Later Profile edits and later Agent configuration updates do not rewrite an existing Run launch or Turn. Both queue promotion and the final pending-to-attempting transaction recheck the current Run, generation/epoch, complete captured configuration, busy state, content bounds and capabilities. A changed configuration fails retained input visibly instead of sending it under different settings. Explicit queue continuation may select a new Run but cannot rewrite the input snapshot or mistake a reset revision counter for matching effective configuration. A new Run with compatible captured settings preserves the existing explicit-continuation workflow.

## Upload and attach Workspace content

Upload through the existing Files panel **before starting the Run**, then choose the authorized file in the input options. Run ownership prevents ordinary Workspace uploads and writes while the Claim is held; attaching existing content does not create a new writer or bypass that lock. The picker lists root files and offers bounded filename search for nested files.

`sessions.sendText` accepts optional `attachments:[{"path":"relative/file.txt","kind":"text"}]` alongside `sessionId` and `text`. Browser callbacks confer no authority. Sessions reads each file through the installed Workspace file service, which verifies directory identity, authorization, canonical scope and symlink rejection. Accepted bytes are copied into a durable input snapshot before the receipt; dispatch never rereads a mutable browser path. Receipts/events expose relative path, kind, byte size and SHA-256, without embedded bytes or native file URIs.

Only negotiated content is encoded:

| Kind | Required capability | Native block |
| --- | --- | --- |
| UTF-8 text without NUL | `embeddedContext` | `resource` with copied `text/plain` content |
| PNG/JPEG signature | `image` | `image` with copied base64 and detected MIME |
| WAV/MP3 signature | `audio` | `audio` with copied base64 and detected MIME |

Text-only Agents retain text prompts; this slice does not offer mutable `resource_link` attachments. Format signatures determine the encoding, not whether an image/audio decoder can render arbitrary content. Unsupported kinds/capabilities, missing files, escaped paths, symlinks, oversized content and invalid UTF-8/media signatures return bounded visible errors before acceptance. Limits are four attachments, 128 KiB per file, 256 KiB raw input total, 512 KiB serialized ACP content and 8,000 serialized attachment-metadata bytes, under the existing 1 MiB ACP frame limit. Text prompt limits remain 16,000 UTF-8 bytes / 24,000 serialized bytes. Unknown usage/cost remains unknown.

The ACP `initialize` request currently declares `clientCapabilities:{}`. Existing Workspace Files and the local Runner do not implement authorized ACP `fs/*` or `terminal/*` handlers. Their presence alone cannot advertise those protocol services. This ticket does not require all optional ACP capabilities.

## Compose or replace the input UI

The default composer uses the selected `aork.sessions.input-options@1` view and ordered `aork.sessions.input-extensions@1` contributions. An independently packaged replacement composer can compose the same providers through public SDK runtime calls:

```tsx
import { SESSION_INPUT_OPTIONS, SESSION_INPUT_EXTENSIONS } from '@aork/contracts/input';
import type { SessionInputContext } from '@aork/contracts/input';

const input: SessionInputContext = {
  version: 1, sessionId, attachments, disabled,
  onAttachmentsChange: setAttachments,
};
return <>
  {runtime.renderView(SESSION_INPUT_OPTIONS, input)}
  {runtime.renderExtensions(SESSION_INPUT_EXTENSIONS, input)}
</>;
```

`UiRuntime.renderView` / `renderExtensions` carry an optional generic context; the business type belongs to the contracts package. Views receive it as `ViewProps.context`, validate its version/shape and diagnose missing context. The composer owns text, attachment drafts and original command identity, including uncertain retries. A known no-acceptance rejection, including actual `WORKSPACE_FILE_CHANGED`, releases uncertainty on either the initial attempt or an original retry while retaining an editable draft. Transport/storage ambiguity retains the same command payload and identity; accepted receipts win before new file validation. The SDK and Host hold no Session draft store. Input options observe Sessions-owned snapshots and events. A local accepted-operation latch clears only for that operation’s authoritative terminal state, a strictly higher configuration operation sequence, or a newer Run generation. Delayed prior-operation facts cannot rewind the projection, and an unrelated global event cursor is not completion proof. Configuration uses public commands and authenticated snapshots; the view never reaches ACP processes or credentials. Agent/Profile/Plugin administration remains in Settings and no standalone artifact/customization navigation is added.

## Bounded timeline and complete original input

The timeline retains the existing 900,000-byte JSON budget. If the normal view exceeds it, the read-only projection omits large per-Turn configuration/attachment collections and sets `detailsOmitted:true`, with small `configurationRevision` / `attachmentCount` summaries where applicable. This does not rewrite the accepted Turn, configuration, user text or privately copied file content.

Every active and queued Turn keeps its identity, dispatch Run/generation, acceptance order and removal/cancellation eligibility in both the resource and owner snapshot. Every actionable original user message remains discoverable, including when active Agent chunks have pushed it beyond the recent-message window. When needed, user previews are limited to 512 serialized JSON bytes at codepoint boundaries and explicitly carry `truncated:true`. The response sets `truncated:true` for omitted details, shortened previews or omitted history. Further byte trimming removes nonactionable history and tool reports; it never shifts active/queued identities out of the response.

Any UI provider can expand the original accepted input through the public `SESSION_TURN_DETAIL` (`sessions.turn`) resource or snapshot with `{turnId}` and parse `turnDetailSchema` from `@aork/contracts/session`. It returns `{sessionId,turn,input}`: current Turn status plus the complete immutable accepted configuration, original user text and attachment references. Identity is resolved through the Turn's saved Session owner, not a caller-supplied Session or native context. The interface is authenticated, strict about parameters and bounded to 64 KiB. It never exposes the private copied file bytes, base64 or native ACP file URIs. Removal/archive is not content deletion.

Default Messages and queue rows expose on-demand “完整输入与配置” expansion and mark shortened previews. The independently installed test UI uses the same public resource/schema. Expansion is a read; it cannot dispatch, replay or rewrite input.

The public large-queue proof uses 100 choices and an accepted configuration of 15,992 bytes (16,000-byte bound), attachment metadata of 7,985 bytes (8,000-byte bound), original text up to 15,999 UTF-8 bytes or 23,993 serialized bytes, and the supported one-active-plus-100-queued state. All 101 identities/order remain visible; full detail remains below 64 KiB. It also verifies actual native delivery of the original copied attachment after the mutable file changes, authorization, removal, restart/no-replay, independent UI expansion and the 390 px view. See `tests/large-input-timeline.test.ts` and `tests/browser/large-input-timeline.spec.ts`.

## Local acceptance

`tests/negotiated-input.test.ts` starts real Host processes, prebuilt Plugins, SQLite, HTTP and managed external ACP processes. Two Agents negotiate different choices; exact initialize/config/prompt wire files prove configuration, immutable UTF-8/image/audio encoding, native boolean shape, unsupported/oversized/format failures, Profile isolation, authoritative updates and crash/no-resend behavior. `tests/browser/negotiated-input.spec.ts` proves actual pre-start UI upload, active-Claim upload refusal, capability-driven controls, visible correction, 390 px layout and independently installed composer/extension reuse with uncertain HTTP delivery, refresh and identical command retry. Only the external Agent/fault boundary is controlled.

Pins: macOS, Node 24.22.3, pnpm 10.30.2, ACP SDK 2.7.0 stable v1, Aork SDK 0.1.0, Playwright 1.58.2, Vitest 4.0.18. These proofs do not replace real Provider 20/21 or Linux/remote acceptance, optional fs/terminal services, MCP tools or native recovery.

Review-repair proofs additionally live in `tests/negotiated-dispatch.test.ts`: a native notification between Runtime intent acceptance and actual initiation, a queued input whose Agent settings change before promotion, a configuration command whose expected revision becomes stale, and a successor Run whose revision counter matches but effective mode differs. Browser proofs include superseding cross-tab operations, a delayed real preacceptance snapshot, and an actual concurrently rewritten file returning `WORKSPACE_FILE_CHANGED` after an uncertain first request. The final native dispatch guard was negative-controlled: removing only that guard reproduced wrong-mode execution; restoring it prevented native dispatch. This enforces the Host’s durably known state; an Agent can independently change its native state before its notification reaches the Host.

After composing accepted tickets 13/14/15, the local regression completed 80 Host tests across eight files and 27 browser tests across five files. The combined permission/configuration case verifies that the offered permission can still be answered, configuration changes are refused during the active Turn, and an Agent mode notification fences queued input with the original snapshot rather than sending it under changed settings. Fresh independent review of the repaired final pin remains required before ticket closure.

The timeline-budget repair gate completed 67 affected Host tests across eight files and 29 browser tests across six files, including the new maximum-budget and independent-detail cases. Runtime initiation/permission code and persistence migrations remain unchanged by this repair. One existing external-mode race test now checks public configuration/dispatch event order, distinguishing a notification in transit from a revision durably known before initiation.
