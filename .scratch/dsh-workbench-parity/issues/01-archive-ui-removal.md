# 01: 归档会话界面入口清理（UI-only，后端休眠）

**What to build:** 确认界面无任何归档会话入口；重写仍断言归档 UI 的过期浏览器测试；同步文档表述。后端 `sessions.archive`、`status:'archived'`、工具级联全部保留不动。

**Blocked by:** 无

**Status:** claimed

- [ ] `plugins/sessions/src/client.tsx`：会话导航/详情/菜单无归档按钮、对话框、复选框；列表过滤保持 `status === 'open'`；详情对已归档旧数据的防御性提示保留。
- [ ] `tests/browser/sessions.spec.ts:51-89,113` 重写：断言更多菜单与会话行不存在「归档会话」入口；不再出现「显示归档会话」复选框。
- [ ] `docs/workbench/navigation-and-reading.md` 与 `docs/sessions/history.md`：「归档控件经 More menu 挂载」改为「归档已从界面移除（后端命令保留休眠）」。
- [ ] 单测（`tests/sessions.test.ts` 等）保持通过（后端未动）。
