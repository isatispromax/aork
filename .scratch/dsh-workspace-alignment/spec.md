# dsh 对齐：工作区管理（单一浏览器、移除归档、移除中央页面）

Status: resolved
日期：2026-11-28
范围：工作区管理逻辑（契约/服务端）+ 左栏单一工作区浏览器 + 中央工作区页面移除
参考：dsh（`~/code/gh/deepseek-harness`：`packages/client/ui-workspace`、`packages/api/workspace-controller`、`packages/workspace/workspace`）
前置：`.scratch/dsh-workspace-management/`（上一轮，小对齐；本轮修订其「保持两个分区」决定）

## Problem Statement

上一轮只做了小对齐。对照 dsh 源码逐项核实，仍有两类差距。

**管理逻辑**

1. 同一目录可重复登记：dsh 以 `realpath` 规范路径为唯一性标准，再次添加返回已有工作区；Aork 每次 `workspace.create` 都插入新记录。
2. 重命名无重名校验：dsh 拒绝重名与空名、未改动不写入；Aork 不查重，且目录移动/丢失时反而拒绝重命名。
3. Aork 多一个工作区归档态（保留登记、拒绝新会话/Run），dsh 没有；归档后没有任何恢复途径。
4. 添加工作区后 dsh 直接进入该工作区开会话（`startSession`）；Aork 跳到中央的工作区详情页。
5. 记录缺 `createdAt`（dsh 悬停卡显示创建时间）。

**界面**

6. 结构：dsh 是单一浏览器——工作区行是分组头，会话嵌在下面，共用一个工具栏（搜索/视图选项/添加）与一个视图菜单（按工作区 / 按工作区树 / 单列表）。Aork 是「工作区 + 会话」两个分区，同一工作区在左栏出现两次；折叠、子工作区排在父级会话之前、落点冒泡到祖先等依赖单棵树的行为都无法成立。
7. 工作区行：dsh 为 32px 行、文件夹图标（悬停换成箭头）、整行点击展开/折叠、800ms 悬停卡（路径/创建时间/复制路径）、右键与 ··· 共用菜单、无会话计数。Aork 为文字字形、点击跳详情页、原生 title、无右键、带计数。
8. 对话框：dsh「重命名工作区」（预填并全选、未改动或重名时禁用确认、重名即时提示）与「删除工作区」（保留边界说明、危险色、列表刷新后才关闭）；Aork 为「编辑工作区 / 移除登记」。
9. 拖拽：dsh 有插入标记并区分落点上/下半，落到后代行时由最近的同级祖先接住；Aork 只有虚线框、固定插到目标之前。
10. 尺寸体系与图标：2px 行距、4px 分组距、24px 操作热区、14px 图标、SVG 线性图标均未对齐。
11. 新建会话的工作区选择器缺「添加工作区…」（目录选择器在 workspace 插件内，跨插件边界没有打通）。
12. 中央的「所有工作区」卡片页与工作区详情页是 Aork 自有设计，dsh 没有中央工作区页面。

## Decisions（2026-11-28，用户已确认）

- **合并为 dsh 单一浏览器**：撤销上一轮「保持两个分区」的决定。左栏只有一个浏览分区，契约沿用 `aork.workspace.navigation@1`。
- **移除中央工作区页面**：删除「所有工作区」卡片页、工作区详情页与「所有工作区」导航入口；未选中会话时中央显示新建会话界面（dsh hero 的对应物）。工作区行点击按 dsh 只做展开/折叠。
- **彻底移除归档**：从契约与 Run 生命周期中删掉工作区 `status` 字段与 `workspace.archive`；`requireOpenWorkspace` → `requireWorkspace`（只校验登记存在）。会话归档（`sessions.archive`，休眠后端）不动。

## Solution

| 区域 | 变更 |
| --- | --- |
| 契约 | `workspaceSchema` 去 `status`、增 `createdAt`；`workspaceInputSchema.name` 可选（服务端按请求目录末段派生，根目录用根本身）；`workspace.rename {id,name}` 取代 `workspace.edit`，重名拒绝 `WORKSPACE_NAME_CONFLICT`，未改动不写不发事件；删 `workspace.archive`/`workspace.archived`；会话 `environment.status` 改为 `open \| unavailable` |
| workspace.create | 按规范目录幂等：已登记同一 `realpath` 则原样返回，不插入、不发 `workspace.created` |
| 左栏浏览器 | workspace 插件提供外壳：工具栏（区头标签、展开式搜索、视图选项菜单、添加工作区）、工作区分组（按工作区/按工作区树）、末尾「未分组」、工作区行（文件夹图标/箭头、悬停操作 ··· 与新建会话、悬停卡、右键菜单、指针拖拽插入标记）、重命名与删除对话框、空态 |
| 会话行 | sessions 插件新增 `aork.sessions.rows@1` 视图：某一分组的会话行（状态点、标题、时间、置顶标记、··· 菜单、水位线 +5、组内拖拽）或搜索结果行；外壳按分组逐个渲染。`aork.sessions.navigation@1` 退役 |
| workbench | 侧栏只挂一个浏览分区；首页未选中会话时渲染新建会话；移除「所有工作区」入口与 `page=workspaces` |
| 选择器 | 新建会话的工作区选择器增「添加工作区…」固定在列表下方，经新的公开视图 `aork.workspace.directory-picker@1` 打开目录选择器，登记后选中 |
| 退役契约 | `aork.sessions.navigation@1`、`aork.workspace.workspace-page@1`、`aork.workspace.browser@1` |

要点：

1. **所有权不变**：外壳归 workspace 插件，会话行归 sessions 插件，二者只经公开视图契约与公开命令/快照组合（ADR-0004）。sessions 未安装时外壳只显示工作区行。
2. **会话数据订阅共享**：每个分组一个会话行视图实例，投影/待处理/未读订阅在插件内共享一份，不随分组数放大。
3. **拖拽数学**：落点以整个分组段（头行 + 子分组 + 会话行）判定上/下半；树模式仅同级，落到后代行时沿 DOM 向上找第一个同级的祖先分组；完整序列由同级子序列就地回填，非同级工作区的位置不变。
4. **视图状态**浏览器本地持久（`aork.workspace.nav.v2`：分组方式、排序方式、折叠），只保留现存工作区的条目。

## 实现中补充的决定

- **右栏门控**：中央页面移除后「只选工作区」即新建会话界面，原门控（内联新建时禁用右栏）会让工作区文件面板无从打开。收窄为「仅在已有会话之上新建时隐藏右栏」；只选工作区时保留右栏（对应 dsh 的空白会话 hero 自带停靠区）。
- **目录选择器视图**画在 body 上并阻止内部表单冒泡，避免被调用方的表单接管。
- **已知偏离**：登记失败原地显示在选择器内（dsh 为独立错误对话框）；行 FLIP 动画与标题跑马灯未做；会话悬停卡沿用原生 title。

## 验收边界

- 单测：`create` 幂等与名称派生、`rename` 查重/未改动、归档命令不存在、`requireWorkspace` 各调用方；分组树与同级拖拽数学；路径后缀。
- 浏览器：单一分区结构（工作区行与会话行同树）；行点击折叠；悬停卡；右键菜单；重命名（预填/重名禁用/即时提示）；删除（保留边界文案、列表刷新后关闭、会话转未分组）；拖拽插入标记与祖先落点；添加工作区后直接进入新建会话；选择器「添加工作区…」；首页为新建会话、无「所有工作区」入口。
- 文档：`docs/workspace/workspaces.md`、`docs/workbench/navigation-and-reading.md`、`docs/sessions/history.md`、`README.md`、`docs/plugins.md`、ADR-0006。

## Out of Scope

- dsh 首次启动自动创建默认工作区（`initializeDefault`）：与 ADR-0005「创建时必须经目录选择器绑定已有目录」冲突，不做。
- 会话内容全文检索（搜索仍为本地元数据匹配）。
- 行 FLIP 动画（dsh `AnimatedRows`）与标题跑马灯：本轮不做，记为已知偏离。
- 会话归档及其三态筛选（已在此前移除界面，后端休眠不变）。
- 工作区 fuzzy 搜索与 NFKC 归一化（选择器搜索仍为前缀/子串）。
