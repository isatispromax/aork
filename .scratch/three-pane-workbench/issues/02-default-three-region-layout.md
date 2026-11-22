# 02: 默认三栏布局、左栏两段式与右栏容器

**What to build:** `plugins/workbench` 的默认布局改为「左栏容器 / 中间对话 / 右栏容器」三区域装配，新增 `inspector` 视图，左栏拆成工作区列表与会话列表两段，偏好读写接入 inspector 语义。

**Blocked by:** 01: 三栏区域的公开契约与扩展点

**Status:** resolved

- [x] `Layout` 结构：`aside.rail` + `div.center`（`header` + `div.columns`：`main` + `aside.inspector`），左右各带 `data-region`。
- [x] `Sidebar` 顺序：品牌 → `aork.workbench.navigation@1` → `aork.workspace.navigation@1` → `aork.sessions.navigation@1` → `aork.workbench.rail-sections@1` → 设置/退出。
- [x] 中间：`header` 渲染会话标题与头部扩展；`main` 上方渲染 `aork.workbench.conversation@1`。
- [x] 新增 `Inspector` 视图并注册为 `inspector`：标题「右侧栏」、加宽/关闭按钮、`aork.workbench.inspector-sections@1`；窄屏隐藏加宽按钮。
- [x] 头部开关改名为「切换右侧栏」，无工作区/会话选择时禁用；<1150px 右栏以 `role=dialog`、`aria-modal` 整宽抽屉呈现，Esc 关闭且焦点回开关；<800px 左栏抽屉行为不变，两者互斥。
- [x] `workbench.preferences` 读取走 `readPreferences`；保存写新 schema；旧 `filesOpen`/`filesWide` 记录刷新后仍生效（主题与开关不丢）。
- [x] `plugins/workbench/aork.plugin.json` 增加 `inspector` 提供者声明。

规格：用户故事 2、3、4、8；Implementation Decisions「默认布局」「偏好兼容」。
