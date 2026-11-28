# 02: 工作区导航重做（树/列表、拖拽排序、行菜单、行内对话框、计数）

**What to build:** `aork.workspace.navigation@1` 升级为 dsh 管理形态。纯逻辑 `workspace-nav.ts`（段边界路径前缀 + 最长匹配定父、order 兜底插入序、树构建）；视图选项 localStorage `aork.workspace.nav.v1`（groupBy list|tree、collapsed、showArchived 迁入）；行 = 字形+名称（归档后缀）+会话计数+悬停 ＋（本工作区新建会话）+···菜单（重命名…/复制路径/归档工作区/移除登记…，照 file-menu.tsx 模式）；移除登记确认框写保留边界；拖拽排序（6px 阈值、ghost、仅兄弟层级）→ `workspace.reorder`。

**Blocked by:** 01

**Status:** resolved

- [x] `plugins/workspace/src/workspace-nav.ts`（`isPathAncestor`/`owningParent`/`orderedWorkspaces`/`navRows`/`ancestorIds`/`completeOrder`）+ `tests/workspace-nav-tree.test.ts`
- [x] `workspace-navigator.tsx`：导航视图独立组件；行菜单直接复用本插件 `file-menu.tsx` 的 `FileMenu`
- [x] `Dialog` 增 `delete` 动作（保留边界文案），由 client.tsx 与 navigator 共用；中央详情页按钮不动
- [x] 树模式：折叠 chevron（持久）、祖先默认展开；**选中展开为持久写入**（`ancestorIds` 命中折叠祖先时清除折叠项），但仅在选择变化时生效——重载时已保存的折叠优先（dsh：saved collapse hides the selection）
- [x] 拖拽：navMain 为按下起点（按下其它按钮不启动），落点写完整序列（含隐藏项保位）；树模式限同父
- [x] 视图菜单（details/summary 加 `role="button"`）每个选项点击后自动收起
- [x] CSS：`.navList/.navRow/.navChevron/.navMain/.navCount/.navActions/.navGhost` 等，替换旧 `.workspaceItem`
