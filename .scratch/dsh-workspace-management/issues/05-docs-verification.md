# 05: 文档同步与全量验证

**What to build:** 文档与新工单收尾、全量验证。

**Blocked by:** 01, 02, 03, 04

**Status:** resolved

- [x] `docs/workspace/workspaces.md`：导航段落重写（dsh 管理形态、目录树、行菜单、拖拽）、新增「Removing a registration」一节、命令表增 `workspace.delete` / `workspace.reorder` 与事件
- [x] `docs/workbench/navigation-and-reading.md`：左栏段落重写（工作区浏览器 + 会话浏览器小对齐）
- [x] `docs/sessions/history.md`：未分组桶、···菜单、+5 水印、选择器说明
- [x] `README.md`：工作区与三栏段落更新
- [x] `pnpm typecheck`、`pnpm check:boundaries` 通过
- [x] 全量 vitest：46 文件 452 条全部通过（Node 24.22.3，`--max-old-space-size=8192 --maxWorkers=2`；两次此前运行出现 dist 被并发重建导致的 MODULE_NOT_FOUND 假失败，与代码无关）
- [x] 全量 Playwright：126 条通过（含本次新增 8 条；`context-handoff.spec.ts` 两条对旧 `<select>` 的 `selectOption` 改为走预设工作区）

## Comments

- 2026-11-27：自检与目检截图发现并修复——`<summary>` 的 ARIA 角色是 group 而非 button（加显式 `role="button"`）；工作区与会话两侧的行拖拽守卫 `closest('button')` 把行主体（按钮）也排除，拖拽永远无法启动（按下目标限定为主按钮）；视图菜单选择后不收起会遮住行点击（改为每项点击后收起）；「选中展开祖先」在重载时覆盖已保存折叠（改为仅在选择变化时持久展开，重载后折叠优先，同 dsh saved-collapse 语义）。目检截图核对树嵌套与行菜单渲染正常。
