# 04: 会话浏览器（dsh 形态）与排序/置顶/重命名命令

**What to build:** sessions 插件左栏导航重做为 dsh 形态会话浏览器；后端新增排序支撑。

**Blocked by:** 无（可与 02/03 并行）

**Status:** claimed

- [ ] `packages/contracts/src/session.ts`：`sessionSchema` 增可选 `updatedAt/pinned/order`；新 schema `renameSessionSchema/setPinSchema/reorderSchema {workspaceId, orderedIds}`。
- [ ] `plugins/sessions/src/server.ts`：durable 命令 `sessions.rename`（名称规则同 create）、`sessions.setPin`、`sessions.reorder`（按组写回 order）；turn 受理/终态与 rename 维护 `updatedAt`（投影回退 `createdAt`）。
- [ ] `Navigation` → `SessionBrowser`：头部（展开式搜索 + 视图选项菜单：分组 按工作区/平铺、排序 最近更新/手动；localStorage `aork.sessions.view.v1`）；按工作区分组（组头=名称+计数+"+"）；平铺单列。
- [ ] 行：状态点（待交互 > 运行中 > 未读/失败）+ 名称 + 相对时间 + 置顶标记；悬停操作：置顶/重命名/交接/···菜单；**无归档项**。
- [ ] 手动拖拽排序：指针拖拽组内重排并切到「手动」；经 `sessions.reorder` 持久化；置顶恒在组首。
- [ ] 水印分页：每组先 5 条「显示更多(+5)/收起」；运行中/待交互/未读/当前选中恒可见；无虚拟化。
