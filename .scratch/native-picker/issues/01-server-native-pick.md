# 01: 服务端原生目录选择资源

**What to build:** `workspace.pickDirectory` 资源：darwin 上经 `osascript choose folder` 弹出系统原生目录选择框并返回绝对路径；同时删除 `workspace.browseDirectory` 资源与 `browse.ts`。

**Status:** resolved

- [x] `plugins/workspace/src/pick.ts`：`createDirectoryPicker({ exec, platform })` 依赖注入；`execFile('osascript', …, { timeout: 10min, maxBuffer: 64K, 固定 PATH env })`；stdout 剥尾斜杠（root 保留）；stderr `-128`/`User canceled` → canceled；非 darwin/ENOENT/其他失败 → `WORKSPACE_PICKER_UNAVAILABLE` (503)。
- [x] 契约 `pickDirectorySchema`：`{status:'chosen', directory}` | `{status:'canceled'}`；删 `browseDirectoryInputSchema`/`browseDirectorySchema`/`BrowseDirectory`/`fileEntrySchema`。
- [x] 并发 guard：in-flight 时 → `WORKSPACE_PICKER_BUSY` (409)。

## Comments

- 2026-11-22：实施完成。`workspace.pickDirectory` 资源注册于 `plugins/workspace/src/server.ts`；`browse.ts` 与资源删除。`tests/workspace-pick.test.ts` 覆盖 chosen/canceled/UNAVAILABLE/busy/超时与脚本转义。真机原生对话框流程待用户手测（无法自动化）。

