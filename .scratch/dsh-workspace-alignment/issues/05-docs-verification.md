# 05: 文档、ADR 与全量验证

**What to build:** 同步 `docs/workspace/workspaces.md`、`docs/workbench/navigation-and-reading.md`、`docs/sessions/history.md`、`README.md`、`docs/plugins.md`；新增 ADR-0006（单一工作区浏览器与移除工作区归档）；`pnpm typecheck`、`pnpm check:boundaries`、全量 vitest 与 Playwright。

**Blocked by:** 01, 02, 03, 04

**Status:** resolved

- [x] 文档与 ADR-0006 已同步；全量验证结果见下方 Comments

## Comments

- 2026-11-28 验证（Node 24.22.3）：`pnpm typecheck`、`pnpm check:boundaries` 通过；全量 vitest 46 文件 453 条全部通过；全量 Playwright 130 条全部通过（最终构建复跑）。
- 旧包升级夹具同步适配：`tests/fixtures/legacy-sessions.ts`（已验收的旧 Session 包：内嵌 Workspace 记录改为现行形状、`requireOpenWorkspace` → `requireWorkspace`、navigation 提供者改答 `aork.sessions.rows@1`）与 `tests/interruption-reconciliation.test.ts`（已验收的旧 Runtime：同名替换）。未在契约里保留兼容别名。
- 首轮全量 Playwright 有一条 `scoped-mcp-tools` 时序抖动（停用插件后 Host 重启窗口内刷新引导，页面显示「启动失败：Failed to fetch」），单独复跑与最终全量复跑均通过，与本次改动无关。
- 目检截图（列表 / 悬停卡 / 目录树 / 搜索 / 选择器 / 删除对话框）与 dsh 形态一致；无页面错误。

