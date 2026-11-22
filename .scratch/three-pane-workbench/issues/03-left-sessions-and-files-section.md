# 03: 左栏会话列表独立、文件视图进入右栏分区

**What to build:** workspace 与 sessions 插件配合新的三栏装配：工作区导航只负责工作区，会话导航成为左栏同级分区；workspace 插件把 Files 视图注册为右栏分区。

**Blocked by:** 02: 默认三栏布局、左栏两段式与右栏容器

**Status:** resolved

- [x] `aork.workspace.navigation@1` 只渲染工作区列表（名称、会话计数、归档标记、显示归档、新建/编辑/归档入口），删除行内嵌套的 `aork.sessions.navigation@1`。
- [x] `aork.sessions.navigation@1` 保持 `aria-label="会话导航"`；未选择工作区时提示「先选择一个工作区查看会话」；已选择时只列该工作区会话并保留「显示归档会话」。
- [x] workspace 插件新增扩展 `files-section` → `aork.workbench.inspector-sections@1`，渲染 `aork.workspace.files@1` 的 `{panel:true, wide}` 形态；`wide` 读布局上下文 `preferences.inspectorWide`。
- [x] 删除 workbench 里硬编码的文件面板标题、禁用「Git 改动」tab 与窄宽/关闭按钮（改由 Inspector 外壳提供）。
- [x] 工作区页与会话页的 Files 呈现不再重复：会话页由右栏提供，工作区详情页保留内嵌文件视图（保持现有可用性）。
- [x] `plugins/workspace/aork.plugin.json`、`plugins/sessions/aork.plugin.json` 按需更新扩展/提供者声明。

规格：用户故事 1、4；Implementation Decisions「工作区与会话插件」。
