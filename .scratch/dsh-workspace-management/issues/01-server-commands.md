# 01: 契约与服务端（workspace order 字段、workspace.delete、workspace.reorder）

**What to build:** `packages/contracts/src/workspace.ts` 的 `workspaceSchema` 增可选 `order`（int ≥0，展示专用，旧记录自然解析）；`plugins/workspace/src/server.ts` 新增 durable 命令 `workspace.delete {id}`（仅解除登记；活跃 Run Claim 拒绝；归档态允许；事件 `workspace.deleted`）与 `workspace.reorder {orderedIds}`（≤500、去重、全部存在；写 `order=index`；事件 `workspace.reordered`），均 `{version:1}` 带回执。

**Blocked by:** 无

**Status:** resolved

- [x] 契约字段与两个命令 schema（`deleteWorkspaceSchema=entityIdSchema`、`reorderWorkspacesSchema {orderedIds ≤500}`）
- [x] `workspace.delete`：prepare 校验存在 + `inspectClaims` 非 unclaimed 即拒绝（`WORKSPACE_WRITE_BUSY`）；execute 删除登记记录并回执被删记录
- [x] `workspace.reorder`：prepare 校验唯一+存在；execute 逐条写 `order=index`，逐工作区发 `workspace.reordered`；`workspace.overview` 保持插入序，客户端按 `order ?? 插入序` 排序
- [x] `plugins/workspace/src/persistence/repository.ts` 增 `deleteWorkspace` 语句
