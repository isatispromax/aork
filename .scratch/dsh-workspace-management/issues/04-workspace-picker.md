# 04: 新建会话工作区选择器（搜索式 picker 替换 <select>）

**What to build:** `plugins/sessions/src/client.tsx` 的 CreateForm 工作区字段换成搜索式 picker 菜单：锚定 portal、≥2 个 open 工作区出现搜索框（名称/路径子串、大小写不敏感；排序 名称前缀>名称子串>路径子串）、Enter 选首个/激活项、Escape 关、列表 6 行滚动、同名工作区用最短唯一路径段后缀区分（纯函数，title=完整路径）。偏离：无「新建工作区…」入口。

**Blocked by:** 无

**Status:** resolved

- [x] `path-suffix.ts`（纯函数 `distinguishingPathSuffixes`，独立模块便于单测）+ `tests/workspace-path-suffix.test.ts`
- [x] `workspace-picker.tsx`：`WorkspacePickerField`（trigger aria-label=选择工作区；`textbox` 搜索框；`role=option` 行带后缀与完整路径 title；↑↓/Enter/Escape；外点关闭）；CreateForm inline/modal 两形态接入
- [x] 搜索排序 `searchRank`：名称前缀 0 > 名称子串 1 > 路径子串 2；无匹配显示空态
- [x] 偏离记录：菜单无「新建工作区…」（目录选择器属 workspace 插件，跨插件边界）；创建仍走工作区分区 ＋
