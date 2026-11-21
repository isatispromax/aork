# 01: 契约层移除 Project，Artifact 改挂 Workspace

**What to build:** 修改 `packages/contracts/src/` 五个契约文件与 SDK 常量，删除全部 project 概念，artifact 归属字段改为 workspaceId，URL hash 键收敛。

**Blocked by:** —

**Status:** ready-for-agent

- [ ] `contracts/workspace.ts`：删 `projectSchema`/`createProjectSchema`/`createProjectResultSchema`/`editProjectSchema`/`requireOpenProject`；`workspaceSchema` 去 `projectId`；`workspaceOverviewSchema` 只回 `workspaces`；`createWorkspaceSchema` 去 `projectId`（L8-22、32、70）。
- [ ] `contracts/workspace.ts`：`readWorkbenchSelection`/`withWorkbenchSelection` 删 `project` 键及 project 变化时的 artifact 级联清理（L49-69）。
- [ ] `contracts/session.ts`：`createSessionSchema`/`sessionSchema`/`completedReplyFactSchema`/`requireSource`/`sessionReferencesSchema`/`createLinkedSessionSchema` 去 `projectId`（L20-22、44、50、68、93）。
- [ ] `contracts/artifact.ts`：`registerArtifactSchema`/`artifactSchema`/`artifactChangedSchema`/`ArtifactViewContext` 的 `projectId` 换 `workspaceId`；`withArtifactSelection` 删 `artifactProject` 键（L20-21、30、48-56）。
- [ ] `contracts/workbench.ts`：`replySummarySchema` 去 `projectId`（L3）。
- [ ] `packages/sdk/src/client.ts`：`UI_CONTRACTS` 删 `aork.workspace.project-page@1`（L7）。
- [ ] contracts 内 grep `project`（除 projection 等无关词）零残留；typecheck/build 通过。

规格用户故事：1, 7, 8。

验收共识：遵循正式规格、修订后领域词汇与 ADR-0005；本票只动契约与常量，不改服务实现；所有下游消费方以本票产物为准。

## Comments

- 2026-11-21：grilling 会话收敛后发布。爆炸半径报告见会话记录；契约是全链路起点，02-08 均依赖本票。
