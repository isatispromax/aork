# 07: 消费方插件界面去 Project（sessions/handoff/artifacts/workbench）

**What to build:** 四个消费方插件的浏览器端全部改用 workspace 归属。

**Blocked by:** 03: 服务层去 Project

**Status:** resolved

- [x] `plugins/workbench/src/client.tsx`：删 `go('projects')`/`projects-link`/「所有项目」扩展按钮（改为「所有工作区」入口，L29-38、226）；pending/unread 跳转去 projectId（L157、167）；`aria-label="跨项目待处理"` 等文案改写；依赖 `selection.projectId` 的 effect 移除（L99）。
- [x] `plugins/sessions/src/client.tsx`：会话导航过滤改按 workspace（L181）；`creationScope`、新建会话表单与 hash 回写去 projectId（L189-213）；「项目」select 改工作区 select（L220）；Detail remount key、环境不匹配守卫与归档文案改写（L235、248-249、269）。
- [x] `plugins/sessions/src/handoff.tsx`：交接表单「目标项目」select 改工作区 select；`artifacts.list` 查询、目标过滤、payload 与 hash 去 projectId（L44-61、70、91、119-120）。
- [x] `plugins/artifacts/src/client.tsx`：全部 `projectId` scope/查询/payload 改 workspaceId（L11-96）；`artifactProject` 判定与 Menu 清理 effect 按新 `withArtifactSelection` 契约；「Project {id}」「<dt>Project</dt>」展示改 Workspace。
- [x] 消费方 grep `projectId`/「项目」零残留；typecheck 通过。

规格用户故事：1, 7, 8。

验收共识：遵循正式规格与 ADR-0005；会话创建、上下文交接、产物登记/列表/版本、待处理跳转的行为语义不变，仅归属轴换 workspace；经真实 Chromium 手测主路径。

## Comments

- 2026-11-21：grilling 收敛后发布。与 ticket 06 同批发布但无相互依赖；hash 键变化以 ticket 01 契约为准。

- 2026-11-22：实施于 `codex/workspace-first`（`08317af`，merge `bbaf556`）。验证：workbench/sessions/handoff/artifacts 客户端 grep `projectId`/「项目」零残留；会话创建、上下文交接、产物登记/列表/版本、待处理跳转行为语义不变（归属轴换 workspace）；浏览器 specs（真实 Chromium）全绿。本票 resolved。
