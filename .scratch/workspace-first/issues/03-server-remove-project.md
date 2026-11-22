# 03: 服务层去 Project（命令/校验/事件/错误码）

**What to build:** 四个 plugin 的 server 层删除全部 project 命令、校验、事件与错误码，artifact 与 session 语义改挂 workspace。

**Blocked by:** 01: 契约层移除 Project，Artifact 改挂 Workspace；02: 持久化 schema 重写

**Status:** resolved

- [x] `plugins/workspace/src/server.ts`：删 `workspace.createProject`/`workspace.editProject`/`workspace.archiveProject` 三条 durableCommand 及 `workspace.projectCreated/Edited/Archived` 事件（L107-160）；删 `requireOpenProject`/`requireProject` 与 `PROJECT_UNAVAILABLE`（L33、93-97）；`prepareWorkspace` 去 projectId 参数（L77-92）；`workspace.overview` 只回 workspaces（L76）；`requireOpenWorkspace` 去 project 状态检查（L20）；`workspace.create` 消费新 `createWorkspaceSchema`（L98）。
- [x] `plugins/sessions/src/server.ts`：删 L307/L376 的 workspace↔project 归属校验与 `SESSION_ENVIRONMENT_MISMATCH`；`requireSource`、live-completion fact、`sessions.references` 去 projectId（L40、69、254）。
- [x] `plugins/artifacts/src/server.ts`：`validate()` 三重校验改 workspace 对象（错误码相应更名，如 `ARTIFACT_WORKSPACE_MISMATCH`）；register/archive 事件与 `artifacts.list` 分区参数改 workspaceId（L26-42）。
- [x] `plugins/workbench/src/server.ts`：replySummary 解析去 projectId（L19-24）。
- [x] 服务端 grep `project` 零残留；typecheck 通过（UI 侧在 06/07 处理）。

规格用户故事：1, 7, 8。

验收共识：遵循正式规格与 ADR-0005；命令去重、单库短事务、事件脱敏等既有机制不变；公开命令与查询经真实 Host 验证基础创建/归档/列表路径可用（完整测试矩阵在 ticket 08）。

## Comments

- 2026-11-21：grilling 收敛后发布。注意 `prepareWorkspace` 保留 external 目录校验（realpath/stat/access），仅去 projectId 参数；managed 分支删除。

- 2026-11-22：实施于 `codex/workspace-first`（`63b293f`，merge `95622ff`）。验证：四个 plugin server 层 grep `project` 零残留；`SESSION_ENVIRONMENT_MISMATCH`/`PROJECT_UNAVAILABLE` 删除；创建/归档/列表路径经单测与浏览器 specs（真实 Host + 真实 Chromium）验证；`pnpm typecheck` 通过。本票 resolved。
