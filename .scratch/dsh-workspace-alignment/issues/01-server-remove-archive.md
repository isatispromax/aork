# 01: 契约与服务端（移除归档、create 幂等、rename 查重、createdAt）

**What to build:** `packages/contracts/src/workspace.ts` 的 `workspaceSchema` 去 `status`、增 `createdAt`；`workspaceInputSchema.name` 可选，服务端按请求目录末段派生名称（根目录用根本身）；`workspace.create` 按规范目录幂等（同一 `realpath` 已登记则原样返回，不插入、不发事件）；`workspace.edit` → `workspace.rename {id,name}`（trim、非空、与其它工作区重名拒绝 `WORKSPACE_NAME_CONFLICT` 409、未改动不写不发事件、不再复验目录）；删除 `workspace.archive` 与 `workspace.archived`；`WorkspaceService.requireOpenWorkspace` → `requireWorkspace`，会话 `environment.status` 改为 `open | unavailable`。同步全部调用方：artifacts、terminal、workspace/files、sessions（server、input）、runtime-acp、测试夹具 planned-run-owner。

**Blocked by:** 无

**Status:** resolved

- [x] 契约变更与调用方同步，`pnpm typecheck` 通过
- [x] `tests/workspaces.test.ts`：幂等、名称派生、rename 查重/未改动、归档命令不存在；原依赖归档制造「不可用」的测试改用 `workspace.delete`

- 已知取舍：`workspace.rename` 对不存在的 id 返回 409 `WORKSPACE_UNAVAILABLE`（原 `workspace.edit` 为 404）；`workspace.create` 命中已登记目录时回执不含事件。
- 原依赖 `workspace.archive` 制造「不可用」的测试改用 `workspace.delete`；`queued-turns` 中「运行中归档」的场景已不可达（删除在 Run 持有目录时被拒绝），改为「结束 Run 后删除登记 → 无法继续队列/启动 Run」。
