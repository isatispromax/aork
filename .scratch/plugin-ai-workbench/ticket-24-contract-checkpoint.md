# Ticket 24 contract checkpoint

Base: 28cfb90 on codex/aork-24, clean managed worktree aork-ticket-15.
Graph tools unavailable; focused source reads are the fallback.

Pinned public seams: real Host authenticated HTTP commands/snapshots/events, independently installed Plugins and public scoped service contracts, actual MCP stdio client/Unix socket bridge, browser replaceable selection child and actual Workspace filesystem operations. Only the external ACP Agent is controlled. No private-table or private-function testing.

Implementation names: TOOLS_SERVICE=aork.tools@1; WORKSPACE_RUN_FILES=aork.workspace.run-files@1; TOOL_SELECTION=aork.tools.selection@1. Tools owns catalog/selection/snapshot/grant/calls; Sessions coordinates synchronous capture within its existing admission transaction; Runtime retains a process-local WorkspaceRunAuthority and RunToolHandle. Run immutable snapshot is run.tools; selected provider IDs join usedPluginIds before reserveClaim. The authority is separate from the same-TX ClaimPermit, issued only to selected Runtime and delegated only to selected Tools through scoped facades.

Runtime mutators become scoped and check actual Sessions consumer. All terminal paths revoke Tools and join actual registered handler plus tracked IO completion; unknown stop keeps Claim blocked. No secrets persist. Default empty selection. Provider registry uses actual owner liveness, nonce disposers, no handler snapshots and bounded scavenging.

Vertical slices: public empty/explicit selection and immutable snapshot; current Claim file authority; real MCP bridge/list/call/write/read; failure/revoke/cancel/IO stop proof; compact replaceable UI; full regression and latest integration merge. Node 24.22.3 exact MCP package proof precedes bridge code.
