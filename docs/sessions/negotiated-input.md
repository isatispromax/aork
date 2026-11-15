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

The receipt records an accepted intent, not successful configuration. Runtime commits dispatching before `session/set_config_option` / `session/set_mode`, then publishes applied only on a definitive native response. Returned option sets and `config_option_update` / `current_mode_update` notifications advance the Run revision. A definitive native RPC rejection is failed with a code-only reason. Uncertain transport, a five-second timeout, invalid Agent state or persistence failure stops the affected managed execution; no configuration is automatically resent. Restart reports attempted configuration as delivery_unknown and keeps the Workspace blocked until execution is verified by the existing lifecycle/maintenance rules.

Each accepted Turn saves its configuration snapshot. Later Profile edits and later Agent configuration updates do not rewrite an existing Run launch or Turn. Dispatch rechecks the Run, generation and negotiated revision; a changed revision fails retained input visibly instead of sending it under different configuration.

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

`UiRuntime.renderView` / `renderExtensions` carry an optional generic context; the business type belongs to the contracts package. Views receive it as `ViewProps.context`, validate its version/shape and diagnose missing context. The composer owns text, attachment drafts and original command identity, including uncertain retries. The SDK and Host hold no Session draft store. Configuration uses public commands and authenticated snapshots; the view never reaches ACP processes or credentials. Agent/Profile/Plugin administration remains in Settings and no standalone artifact/customization navigation is added.

## Local acceptance

`tests/negotiated-input.test.ts` starts real Host processes, prebuilt Plugins, SQLite, HTTP and managed external ACP processes. Two Agents negotiate different choices; exact initialize/config/prompt wire files prove configuration, immutable UTF-8/image/audio encoding, native boolean shape, unsupported/oversized/format failures, Profile isolation, authoritative updates and crash/no-resend behavior. `tests/browser/negotiated-input.spec.ts` proves actual pre-start UI upload, active-Claim upload refusal, capability-driven controls, visible correction, 390 px layout and independently installed composer/extension reuse with uncertain HTTP delivery, refresh and identical command retry. Only the external Agent/fault boundary is controlled.

Pins: macOS, Node 24.22.3, pnpm 10.30.2, ACP SDK 2.7.0 stable v1, Aork SDK 0.1.0, Playwright 1.58.2, Vitest 4.0.18. These proofs do not replace real Provider 20/21 or Linux/remote acceptance, optional fs/terminal services, MCP tools or native recovery.
