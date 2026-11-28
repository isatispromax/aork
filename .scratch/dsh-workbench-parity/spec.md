# dsh 对齐：会话浏览器、右栏停靠面板、设置页与归档入口清理

Status: in-progress
日期：2026-11-22
范围：会话导航重做 + 右栏停靠化（完整版）+ 设置层重做 + 归档界面入口移除
参考：dsh（`~/code/gh/deepseek-harness` 的 ui-workspace / ui-sidebar-right / ui-dockkit）与 ZCode 设置层（`~/code/multai/ZCode/packages/ui/src/SettingsPage.tsx`）

本规格修订 `.scratch/three-pane-workbench/spec.md` 中「Out of Scope」明确排除的三项：右栏分区持久化折叠状态、多右栏并排（分屏/浮动）、拖拽排序。不改变 ADR-0004「全部正常界面经公开契约替换」决策，不改变 ADR-0005 的 Workspace 顶层组织单位。

## Problem Statement

1. **会话列表与 dsh 不一致**：`aork.sessions.navigation@1` 只渲染当前工作区的纯名字平铺（按创建序），没有搜索、分组视图、置顶、重命名、状态点、相对时间，也没有「按更新时间/手动拖拽排序」。
2. **右栏没有类型选择与扩展**：`aork.workbench.inspector-sections@1` 把所有贡献按顺序堆叠，用户不能选择打开哪一类面板，也没有分屏、浮动和按会话记住布局；dsh 的右栏是「顶部 tab 条 + 引导页选型 + 类型注册表扩展点 + 每会话持久化 + 分屏/浮动」。
3. **归档会话界面残留**：UI 已删但浏览器测试仍断言归档 UI（当前红），文档仍描述「More menu 挂载归档控件」。用户决定：项目里不出现归档会话选项（后端命令/契约休眠保留）。
4. **设置界面过小**：页脚 `<dialog>` 只有主题下拉，与 ZCode 的全窗口设置层（左分组导航 + 右圆角面板 + 卡片行）差距大。

## Solution

| 区域/界面 | 容器 | 扩展点/数据 | 默认内容 |
| --- | --- | --- | --- |
| 右栏 | `aork.workbench.inspector@1`（不变，仍可整体替换） | 新 `aork.workbench.inspector-tabs@1`（取代 `inspector-sections@1`；扩展=面板类型，manifest 增 `multiple`） | workbench 停靠外壳：tab 条 + 引导页 + 分屏/浮动 + 每会话持久化；Files 为第一个类型 |
| 左栏会话段 | `aork.sessions.navigation@1`（不变） | 既有 `sessions.overview` + 新命令 `sessions.rename/setPin/reorder` + session 记录新可选字段 `updatedAt/pinned/order` | dsh 形态会话浏览器：分组/平铺、排序（最近更新/手动拖拽）、置顶、搜索、状态点、水印分页 |
| 设置 | `aork.settings@1`（不变，仍由 workbench 提供） | 既有 `aork.settings.sections@1` 插件贡献（manifest 补 label/icon） | ZCode 形态全窗口层：左导航（内置「外观」+ 扩展分区）+ 右圆角面板卡片行 |
| 「文件」面板（2026-11-27 追加，工单 07） | `aork.workspace.files@1`（不变，仍可整体替换） | 既有 `workspace.files` / `workspace.search` 资源；搜索增可选 `includeHidden` | dsh 形态文件页：惰性目录树、即时搜索、路径标题行、行菜单；点文件进预览，编辑留在面板内 |
| 归档 | 无界面 | 无（后端休眠） | 无任何归档入口；测试断言不存在 |

要点：

1. **停靠引擎独立成包**：`packages/dock`（纯逻辑 split 树 + 可逆操作 + undo/redo；React 组件：DockSurface/PaneTree/TabLayout/FloatLayer），host 无关、无业务依赖，参照 dsh ui-dockkit 的两层结构。
2. **面板类型 = 扩展**：沿用 manifest 声明 + `registerExtension`，不引入第二套注册机制；`multiple:true` 类型每次打开产生独立实例。
3. **每会话持久化在浏览器本地**：`aork.inspector.v1.<sessionId>`（无会话用 `default`），不新增服务端数据；布局偏好 `inspectorOpen/inspectorWide` 不变。
4. **归档只删界面**：后端 `sessions.archive`、`status:'archived'`、工具级联保留休眠；会话列表只显示 `open`；文档改为「归档已从界面移除（后端保留）」。
5. **设置机制不变**：`aork.settings.sections@1` 仍是插件贡献；workbench 只把外壳从对话框换成全窗口层，内置「外观」分区走同一条扩展渲染路径。

## User Stories

1. 作为用户，我希望能按工作区分组或平铺浏览全部会话，按最近更新排序或手动拖拽排序，以便像 dsh 一样定位会话。
2. 作为用户，我希望能置顶、重命名、交接会话，并在行上看到运行/待交互/未读状态与相对更新时间。
3. 作为用户，我希望右栏顶部有 tab 条，能从引导页选择面板类型（文件…），能分屏并排、拖出浮动窗口，切换会话后布局各自保留。
4. 作为插件作者，我希望能声明一个新的右栏面板类型（一个扩展 + manifest 元数据），不改 Host 代码即可出现在引导页。
5. 作为用户，我希望设置是全窗口页面：左侧分类导航，右侧卡片行；主题、Agent 配置、插件管理、诊断都在里面。
6. 作为用户，我希望项目里完全没有归档会话的界面入口。

## Implementation Decisions

- 契约：`UI_EXTENSION_TARGETS` 用 `aork.workbench.inspector-tabs@1` 替换 `aork.workbench.inspector-sections@1`（预发布期直接替换，workspace files-section 同步迁移）；extension schema 增可选 `multiple`；`sessionSchema` 增可选 `updatedAt/pinned/order`（strict 保持，旧记录自然解析）。
- 会话排序：`updatedAt` 由服务端在 turn 受理/终态与 rename 时维护，投影回退 `createdAt`；`sessions.reorder {workspaceId, orderedIds}` 写回 order 序号；置顶行恒在组首；拖拽行自动切到「手动排序」。
- 停靠持久化：localStorage，key 按会话；浮动窗=容量 1 的 pane，无 tab 条；undo/redo 仅在 dock 状态内部。
- 设置层：全窗口层 `role="dialog" aria-modal`，后方布局 `inert`；左栏 <900px 收成图标栏；内容列 `max-w-4xl`；主题 token 增补 `--aork-hover/--aork-selected/--aork-input` 等（additive）。
- 搜索：本轮只做本地元数据匹配（名称/工作区名/ID），不做会话内容全文检索。

## 验收边界

- 单元：dock 引擎 ops 与逆操作往返、undo/redo；契约 schema 新字段与旧记录兼容；rename/setPin/reorder 命令；manifest `multiple` 校验。
- 浏览器：归档入口不存在断言；会话浏览器（分组/平铺、置顶、重命名、拖拽排序持久化、搜索、水印分页）；停靠面板（引导页选型、Files tab、分屏、浮动、按会话保留、独立插件替换 inspector 容器）；设置层（打开/分区渲染/主题生效/Esc 焦点还原）。
- 文档：`docs/workbench/navigation-and-reading.md`、`docs/sessions/history.md`、`README.md` 同步。

## Out of Scope

- 会话内容全文检索；归档后端移除与数据迁移；工作区归档界面（仍是工作区功能）；面板类型的媒体预览/浏览器/终端（后续插件）；`aork.sessions.navigation@1` 容器替换。
- 文件页（工单 07）：预览分栏旁可开关的导航树（dsh `ui-sidebar-files` 的另一半，需要跨插件视图契约）、文件监听自动刷新（Aork 没有服务端文件事件）、搜索排除规则面板与 `.gitignore` 支持、新建目录 / 重命名 / 删除 / 拖拽上传。
