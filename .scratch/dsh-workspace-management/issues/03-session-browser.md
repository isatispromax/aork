# 03: 会话浏览器小对齐（未分组桶、···菜单、+5 水印）

**What to build:** `plugins/sessions/src/session-browser.tsx`：workspaceId 不在 workspace.overview 的会话归入末尾「未分组」组（无 ＋、无拖拽、最近更新序）；行悬停三按钮收敛为 ··· 菜单（置顶/取消置顶、重命名…、复制会话 ID、分隔线、交接到新会话…）；「显示更多」改 +5 步进（剩余 ≤5 时一次展开），「收起」复位。

**Blocked by:** 01（移除登记产生未分组数据源）

**Status:** resolved

- [x] 未分组桶：`names.has(workspaceId)` 为假的会话进末尾 `{key:'ungrouped', title:'未分组', workspaceId:null}`；组头无 ＋；拖拽要求 `current.workspaceId === group.workspaceId`（组外拖入/组内拖出都不提交）
- [x] `row-menu.tsx`（file-menu 模式按本插件样式重绘）替换三个直排按钮；复制会话 ID 走剪贴板，失败行内 alert
- [x] 水印 +5 步进：剩余 ≤5 一次展开；「收起」复位
- [x] 顺带修复既有缺陷：`rowPointerDown` 的 `closest('button')` 守卫使行主体按钠除外（原实现行内拖拽永远无法启动）；行主按钮加 `data-row-main`
