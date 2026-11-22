# 三栏工作台：左侧工作区＋会话、中间对话、右侧可扩展侧边栏

Status: resolved
日期：2026-11-22
范围：默认布局重组 + 三个区域的公开 UI 契约与扩展点

本规格修订 `.scratch/plugin-ai-workbench/spec.md` 用户故事 54、73、74、77 中关于布局的表述，不改变 ADR-0004 的「全部正常界面经公开契约替换」决策，也不改变 ADR-0005 的顶层组织单位（Workspace）。用户已确认本次交付范围是「规格 + 工单 + 实现」。

## Problem Statement

当前默认布局把两块不同的导航挤在左栏同一棵嵌套树里：工作区列表是 `aork.workspace.navigation@1`，会话列表 `aork.sessions.navigation@1` 被工作区插件渲染进每个工作区的行内展开区。结果是（1）用户必须先点开一个工作区才能看到会话，无法像 dsh 那样「左边选项目、下面是这个项目的会话」；（2）左栏的第三个可插拔位置只剩一个笼统的 `aork.workbench.navigation@1`，任何插件想加一块「最近会话 / 待处理 / 收藏」只能挤进顶部按钮区。

右栏问题更直接：所谓「右侧侧边栏」其实只是 workbench 布局里硬编码的一块 Files 面板——标题「文件」、写死的禁用「Git 改动」tab、宽窄切换按钮、关闭按钮全部由布局组件私有实现，内容写死 `runtime.renderView('aork.workspace.files@1', …)`。插件既不能往右栏增加分区，也不能只替换右栏本身而不替换整个布局；这与「三个区域都能由插件扩展与定制」直接冲突。同时布局偏好里 `filesOpen`/`filesWide` 这两个名字把「右栏」等同于「文件」，任何非文件型右栏内容都得沿用文件的开关语义。

## Solution

把默认工作台明确成三个区域，每个区域各有「可替换的区域容器契约」与「区域内的扩展点」：

| 区域 | 区域容器（独占可替换） | 区域内扩展点（多插件贡献） | 默认内容 |
| --- | --- | --- | --- |
| 左侧 | `aork.workbench.sidebar@1` | `aork.workbench.navigation@1`（顶部动作）、`aork.workbench.rail-sections@1`（新增，导航下方的分区） | 品牌行、新建会话/待处理/所有工作区、**工作区列表**、**会话列表**、设置与退出 |
| 中间 | 头部 `aork.workbench.header-view@1` + 主体 `aork.workbench.main@1` | `aork.workbench.header@1`、`aork.workbench.toolbar@1`（头部内）、`aork.workbench.conversation@1`（新增，主体上方的窄条） | 会话标题、会话详情（消息/输入/审批/工具）、工作区页面 |
| 右侧 | `aork.workbench.inspector@1`（新增，独占可替换） | `aork.workbench.inspector-sections@1`（新增，多插件贡献分区） | 右侧栏外壳（标题、加宽、关闭）＋ 由 workspace 插件贡献的「文件」分区 |

要点：

1. **左侧两段式**：工作区列表与会话列表成为同级两块，而不是嵌套树。工作区插件只负责工作区（含创建/编辑/归档入口与会话计数），会话插件只负责当前工作区的会话列表，工作台侧栏负责把两者与扩展分区按顺序装配。未选择工作区时会话分区给出明确提示，不伪造「全部会话」视图。
2. **右侧栏成为独立契约**：新增 `aork.workbench.inspector@1`，默认由 `workbench` 插件提供外壳；内容来自 `aork.workbench.inspector-sections@1` 的扩展贡献。workspace 插件把自己的 Files 视图注册为其中的一个分区，从而不再由布局硬编码。原「Git 改动」占位 tab 删除——Git 分区应当由将来的 Git 插件作为独立分区贡献，而不是一个永远禁用的假 tab。
3. **偏好改名并兼容读取**：`filesOpen`/`filesWide` 改为 `inspectorOpen`/`inspectorWide`；`workbench.preferences` 读取时接受旧记录（旧的 `filesOpen`→`inspectorOpen`、`filesWide`→`inspectorWide`），写入一律使用新 schema。不新增数据库迁移；旧记录在首次保存后自然升级。
4. **扩展点必须真的可安装验证**：新增三个扩展目标必须能被独立打包的插件声明并渲染；浏览器验收用一个独立安装的 UI 包同时往左、中、右三个区域加分区，证明三处扩展都走公开契约且互不覆盖。
5. **窄屏不退化**：左侧仍是抽屉，右侧在 <1150px 变为整宽抽屉并保留焦点返回；两个开关的 `aria-expanded`、抽屉的 `role=dialog`、Esc 关闭与焦点还原保持现有行为。

不做：不引入新的服务端数据（右栏分区纯展示，数据仍由各分区自己经公开查询/快照读取）；不改变 URL 选择键；不恢复 Project 层；不实现真实 Git 分区。

## User Stories

1. 作为工作台用户，我希望左侧先看到工作区（项目）列表、其下再看到该工作区的会话列表，以便像 dsh 一样两步完成定位，而不必逐层展开。
2. 作为工作台用户，我希望能从任何会话页一键收起/展开右侧栏，以便给对话更多宽度。
3. 作为工作台用户，我希望右侧栏在宽屏可加宽，在窄屏以整宽抽屉出现并可用 Esc 关闭、焦点回到开关，以便在手机上也能查看文件。
4. 作为工作台用户，我希望右栏不是「只能是文件」，将来安装其它插件后也能在同一右栏看到它们的视图，以便按工作方式组织右侧空间。
5. 作为插件作者，我希望左栏导航、左栏分区、中间窄条、右栏分区、区域容器五个位置都有稳定的公开契约与版本，以便不修改 Host 即可扩展或整体替换某一栏。
6. 作为插件作者，我希望替换某一栏时仍然可以复用其它栏的公开子视图，以便只定制我关心的区域。
7. 作为工作台维护者，我希望旧的布局偏好记录不会让页面报错或重置主题，以便升级后用户的主题与开关状态保持可用。
8. 作为工作台用户，我希望布局偏好（左右开关、右栏宽度、主题）跨刷新与重启保留，以便每次进入都是上次的工作状态。

## Implementation Decisions

### 公开契约

- `@aork/sdk/client`：`UI_CONTRACTS` 增加 `aork.workbench.inspector@1`；`UI_EXTENSION_TARGETS` 增加 `aork.workbench.rail-sections@1`、`aork.workbench.inspector-sections@1`、`aork.workbench.conversation@1`。新增项按契约主版本 `@1` 处理，不提供 `@0` 兼容。
- `@aork/contracts/workbench`：新增常量 `WORKBENCH_INSPECTOR`、`RAIL_SECTIONS`、`INSPECTOR_SECTIONS`、`CONVERSATION_BAND`；`preferencesSchema` 改为 `inspectorOpen`/`inspectorWide`；新增 `readPreferences(value: unknown)` 负责严格解析与旧字段归一。`WorkbenchLayoutContext` 结构不变（`preferences`、`save`、`narrow`），因此右栏分区与左栏分区可以从上下文里读到宽度与开关状态。
- 区域容器与分区都只消费公开查询/命令；分区不得导入其它插件源码。

### 默认布局

- `Layout` 的 DOM 结构：`aside.rail`（左）＋ `div.center`（header + `div.columns`：`main` + `aside.inspector`）。左栏与右栏各自带 `data-region="left|center|right"`，便于主题 CSS 定位，不构成业务契约。
- `Sidebar`（左栏容器）：品牌行 → `aork.workbench.navigation@1` → `aork.workspace.navigation@1` → `aork.sessions.navigation@1` → `aork.workbench.rail-sections@1` → footer（设置、退出）。
- 中间：`header` 内渲染 `aork.sessions.header@1` 与头部扩展；`main` 上方渲染 `aork.workbench.conversation@1` 窄条（无贡献时不占空间）。
- `Inspector`（右栏容器，新视图 `inspector`）：标题「右侧栏」＋ 加宽/关闭按钮（窄屏隐藏加宽）＋ `aork.workbench.inspector-sections@1`。可见条件：`inspectorOpen` 且已选择工作区或会话。
- 头部开关：`切换导航`（左）、`切换右侧栏`（右，无选择时禁用）。左抽屉仍在 <800px 生效，右抽屉在 <1150px 生效；两者互斥打开。

### 工作区与会话插件

- `workspace` 插件：`aork.workspace.navigation@1` 只渲染工作区列表（名称、会话计数、归档标记、显示归档、新建入口），不再渲染 `aork.sessions.navigation@1`；新增扩展 `files-section` → `aork.workbench.inspector-sections@1`，内部渲染 `aork.workspace.files@1`（`{panel:true, wide}`，`wide` 取自布局上下文）。
- `sessions` 插件：`aork.sessions.navigation@1` 保持自己的 `aria-label="会话导航"`，改为左栏同级分区；未选择工作区时显示「先选择一个工作区查看会话」，不再渲染空的「暂无会话」。

### 偏好兼容

- 服务端读取 `workbench.preferences` 时调用 `readPreferences`：旧记录 `{theme, sidebarOpen, filesOpen, filesWide}` 归一为新字段；字段缺失或类型错误则回落到默认值，不抛错（布局偏好不是业务状态）。
- 写入仍走 `workbench.savePreferences` 的严格新 schema；旧客户端提交旧 payload 会被 400 拒绝，属于既有的「旧页面需刷新」边界。

### 验收边界

- 单元：契约常量、偏好兼容读取、manifest 校验接受新契约/扩展目标、profile 组合校验拒绝缺失的 inspector 提供者。
- 浏览器（真实 Host + SQLite + Chromium）：三栏同时可见；左栏工作区与会话为同级两段；右栏开关/加宽/关闭与刷新后保留；<1150px 右栏为 dialog 且 Esc 后焦点回到开关；<800px 左栏为 dialog；独立安装的 UI 包向三个区域各加一个分区并同时可见；替换整个 layout 与单独替换 inspector 各自由公开契约完成。
- 文档：`docs/workbench/navigation-and-reading.md` 的组成表与偏好段落更新；`docs/sessions/history.md` 中「会话导航由工作区浏览器装配」的表述改为「由布局装配」；README 工程边界表更新 `plugins/workbench` 一行。

## Out of Scope

- 真实 Git 分区与 diff；右栏分区持久化折叠状态；多右栏并排；拖拽排序。
- 服务端 schema 变更或数据迁移；URL 键变更；Project 层恢复。

## Comments

- 2026-11-22：规格、四张工单与实现同轮交付。公开契约新增 `aork.workbench.inspector@1` 与三个扩展目标（`rail-sections`／`conversation`／`inspector-sections`）；布局偏好改名为 `inspectorOpen`／`inspectorWide`，读取时兼容旧 `filesOpen`／`filesWide` 记录（逐字段回退，不抛错）。默认布局拆成左／中／右三区域，左栏工作区与会话成为同级分区，右栏容器由布局持有开关与宽度、内容来自扩展分区，workspace 插件以 `files-section` 扩展贡献文件视图并删除硬编码的「文件」标题与禁用「Git 改动」tab。验收：`pnpm typecheck`、`pnpm check:boundaries`、全量 `vitest` 362/362、`playwright` 108/108 全绿（含新增的三栏默认装配、只替换右栏容器两个用例，以及独立 UI 包向三区域各贡献分区的断言）。测试期间发现 `pnpm dev` 的监听重建会与 `pnpm build` 竞争删除 `dist/`，导致 Playwright webServer 偶发 `ENOENT dist/runtime/import-map.json`；这是开发脚本与测试并发时的既有竞态，不是本次改动的回归。
