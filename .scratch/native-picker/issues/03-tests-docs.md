# 03: 测试迁移与文档更新

**What to build:** 删旧选择器测试、迁移全部 access 引用、更新文档与旧票备注。

**Blocked by:** 02: 新建工作区对话框重做与 access 概念移除

**Status:** superseded（access 移除相关仍生效）

- [x] 删 `tests/directory-picker.test.ts`、`tests/workspace-browse.test.ts`；新增 `tests/workspace-pick.test.ts`。
- [x] `tests/browser/workspaces.spec.ts`：助手改手输路径；删 picker 专属用例；新增 `page.route` stub `workspace.pickDirectory` 三分支。
- [x] ~15 个单测文件与 fixture 去 `access`；scoped-mcp-tools 的 read-only claim 用例删除；`workspace-files.spec.ts` 去 访问权限 selectOption 与只读用例。
- [x] GLOSSARY 词条反转、README、docs/workspace/*、docs/tools/scoped-mcp.md；`.scratch/workspace-first` 05/06 追加 superseded 备注。

## Comments

- 2026-11-22：全部门禁绿：`pnpm typecheck`、`pnpm check:boundaries`、`pnpm test`（38 文件 345 用例）、Playwright 105/105。legacy 升级 fixture（`tests/fixtures/legacy-sessions.ts`）需要同步剥掉 234d9ac 旧 workspace 契约中的 access 行，否则内嵌 strict parse 拒绝当前无 access 的 Workspace 对象。

- 2026-11-22：部分撤销——access 相关测试迁移与文档更新保留；pickDirectory stub 用例与原生描述已随 `.scratch/mac-picker` 回退。
