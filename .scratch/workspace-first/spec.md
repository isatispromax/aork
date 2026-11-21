# 移除 Project 层，工作区成为顶层组织单位，并交付 mac 式目录选择器

Status: needs-triage
日期：2026-11-21
范围：领域模型变更（移除 Project）+ 目录选择器（Directory Picker）

本规格经 grilling 会话三轮收敛后由用户确认（2026-11-21，用户逐轮回复「都按推荐来」「按推荐来」「ok」）。它修订 `.scratch/plugin-ai-workbench/spec.md` 中用户故事 4、5、6、24 及所有提及项目概念的表述；词汇以修订后的 `GLOSSARY.md` 与 `docs/adr/0005-remove-project-layer.md` 为准。`needs-triage` 表示需求已收敛待维护者复核拆票，不表示功能已实现。

## Problem Statement

Project 在当前模型中是一个纯逻辑容器：只有名字，不绑目录、不参与执行，却贯穿契约、持久化、界面与测试。用户每次新建都必须先理解「项目 ≠ 目录」的两层概念，再走「项目名 + 工作区名 + 目录管理」的表单；想把已有目录接进来，只能手打服务器绝对路径——没有任何浏览辅助，容易拼错（浏览器测试专门覆盖了「填错重试」的路径）。与此同时，Aork 是纯 Web 应用（浏览器 + 本机 Node server，远程部署是设计目标），浏览器原生的 File System Access API / `webkitdirectory` 只能浏览浏览器所在机器的沙箱路径，拿不到服务器上的绝对路径，因此「mac 文档选择器」只能做成应用内自绘的目录浏览器 + 服务端浏览资源。

单独加选择器而不动模型，会留下「项目」这层零信息量的组织壳。用户已决定整体移除 Project：Workspace 成为唯一顶层组织单位，一律绑定用户选定的服务器目录。

## Solution

1. **领域模型**：删除 Project 实体及其全部契约、持久化、命令、事件与界面。Workspace 升级为顶层组织单位，创建时必须通过目录选择器绑定服务器上一个真实目录（managed 自动建目录模式删除）。Artifact、Session、回复摘要等一切归属从 projectId 改为 workspaceId。
2. **目录选择器**：新建工作区对话框内提供仿 macOS NSOpenPanel 的目录浏览对话框：单击选中、双击/Enter 进入、底部「选择」确认、未选中时「选择」= 当前浏览目录、文件灰显不可选、symlink 显示为 symlink（登记时服务端照常解析 realpath 并记录 requestedDirectory vs directory）。v1 元素：快捷入口栏（主目录/桌面/文稿/下载，起点主目录）、前往文件夹路径输入（⇧⌘G 等价，也是 `~/.config` 等隐藏目录的唯一入口）、隐藏文件切换（默认隐藏 dotfiles，纯前端过滤）。新建文件夹按钮 defer 到后续版本（需要新的服务端公开 mkdir 能力）。
3. **服务端浏览资源**：新增 browse-only resource（如 `workspace.browseDirectory`），参数为服务器绝对路径，返回单层目录元数据（复用 `FileEntry` 形态，不含 workspaceId）。不读文件内容、不跟随 symlink 展开、复用 `FILE_LIMITS.entries` 500 条截断（截断时提示用前往文件夹）与字节上限；权限不足或目录不存在在位报错，不泄露超出目录元数据的系统信息。授权 = 现有登录态（HMAC Cookie / CSRF / Origin 边界不变）。这是新的文件系统暴露面：现网所有 fs 访问都被锁在已登记工作区的 device/inode 边界内，此资源按单用户可信实例的姿态放开「只列不读」。
4. **持久化**：不写数据迁移。直接修改历史 migration 声明（v1：删除 projects 表，workspaces 表去掉 project_id 列与索引；artifacts 表 project_id 列与索引换为 workspace_id）。代价：**升级后必须清空数据目录重建**（迁移运行器的 checksum 校验会使旧库拒启），spec 与 README 明确此点。sessions/workbench 在 record JSON 内嵌的存量 projectId 同样随清库作废，不做兼容读取。
5. **界面**：左导航项目树变单层工作区列表；「所有项目」页改造为「所有工作区」页（卡片显示工作区名、目录路径、状态、会话数）；会话创建与上下文交接表单的「项目」select 变为工作区 select；file-view 可写判定改为仅看 workspace 状态；URL hash 删除 `project` 与 `artifactProject` 键，`workspace`/`session`/`directory`/`file`/`line`/`artifact`/`artifactVersion` 保留，artifact 选中态挂 workspace。

## User Stories

1. 作为工作台用户，我希望工作区是唯一的顶层组织单位，以便直接从浏览器找到并进入每个工作环境，不必先理解项目层。
2. 作为工作台用户，我希望新建工作区时通过 mac 文档选择器风格的目录选择器挑选服务器目录，以便不用手打绝对路径。
3. 作为工作台用户，我希望在选择器里逐层浏览目录、单击选中、双击进入、按钮确认，以便用 macOS 的肌肉记忆完成选择。
4. 作为工作台用户，我希望选择器提供主目录/桌面/文稿/下载快捷入口和前往文件夹路径输入，以便快速到达常用位置和隐藏目录（如 `~/.config`）。
5. 作为工作台用户，我希望列表默认隐藏 dotfiles 并可一键切换显示，以便列表干净又能在需要时进入隐藏目录。
6. 作为工作台用户，我希望新建工作区时保留只读/可读写选择和「授权此目录及其子目录」确认，以便明确交给服务端的访问范围。
7. 作为工作台用户，我希望产物归属于其产生的工作区，以便在环境内查看和管理结果；工作区归档后产物仍只读可见。
8. 作为工作台用户，我希望会话创建和上下文交接只选择工作区，以便流程少一层概念。
9. 作为工作台用户，我希望升级说明明确告知需清空本地数据目录，以便理解旧库不迁移的现实并自行备份想保留的外部目录路径记录。

## Implementation Decisions

### 领域模型

- GLOSSARY 删除 Project 词条；Workspace 定义改为「顶层组织单位，绑定服务器上一个明确目录的文件环境，拥有稳定身份和访问范围」；新增「目录选择器」词条。产品从此没有「与代码无关的纯组织容器」；分组需求将来若出现，以 Workspace 属性或独立分组机制重新评估，而不是恢复 Project（见 ADR-0005）。
- Artifact 挂 Workspace：`registerArtifactSchema`/`artifactSchema`/`artifactChangedSchema`/`ArtifactViewContext` 的 projectId 全部换 workspaceId；`artifacts.list` 分区键改 workspaceId（物理列与索引同步）；`ARTIFACT_PROJECT_MISMATCH`/`ARTIFACT_SOURCE_MISMATCH` 校验对象换 workspace。
- Session 派生契约去 projectId：`createSessionSchema`/`sessionSchema`/`completedReplyFactSchema`/`requireSource`/`sessionReferencesSchema`/`createLinkedSessionSchema`；`SESSION_ENVIRONMENT_MISMATCH`（workspace 归属 project 校验）删除。workbench `replySummarySchema` 去 projectId。
- workspace 侧：删 `projectSchema`/`createProjectSchema`/`createProjectResultSchema`/`editProjectSchema`/`requireOpenProject` 与 `workspace.createProject`/`workspace.editProject`/`workspace.archiveProject` 命令及 `workspace.projectCreated/Edited/Archived` 事件；`workspaceSchema` 去 projectId；`workspaceOverviewSchema` 只回 workspaces；`createWorkspaceSchema` 去 projectId；`PROJECT_UNAVAILABLE` 错误码删除；`requireOpenWorkspace` 只查 workspace 状态。
- URL 选中态：`readWorkbenchSelection`/`withWorkbenchSelection` 删 `project` 键及其对 artifact 键的级联清理；`withArtifactSelection` 删 `artifactProject` 键。
- 工作区创建即登记目录：external 表单字段（访问权限、授权 checkbox）保留，默认可读写；managed 分支删除。

### 目录选择器交互

- 宿主为原生 `<dialog>` + `showModal()`（仓库惯例），样式走 CSS Modules + `--aork-*` token。
- 列表：目录优先排序（localeCompare），文件行灰显不可选，symlink/other 标注 kind；面包屑 + 上一级；快捷栏四项静态入口；底部「选择」主按钮。
- 语义细节：单击选中；双击/Enter 进入目录；Enter 在已选中行上同双击；「选择」在未选中行时选当前浏览目录，选中文件行时禁用；Esc 关闭不选中。
- 前往文件夹：接受绝对路径与 `~` 展开；目标不存在或不可读时在位报错；这是进入隐藏目录（默认隐藏 dotfiles 时）的唯一途径。
- 截断：>500 条时列表尾提示截断并建议用前往文件夹直达。

### 服务端浏览资源安全姿态

- 单层元数据 only；不展开 symlink 子树；不提供读内容、写、建目录任何衍生能力。
- 错误统一在位返回，不区分「不存在」与「无权限」之外的系统细节。
- 单用户可信实例姿态；若未来出现多主体部署，需重新评估（届时可收紧为只允许浏览已登记目录的邻近范围），v1 不做。

### 影响面与实施顺序

爆炸半径已查明（2026-11-21，代码探查）：契约 5 个文件、持久化 3 处、服务层 4 个 plugin、UI 4 个 plugin（20+ 文案与逻辑点）、测试 1 个 fixture 牵动 20 个单测文件与 18 个 browser spec 直写 `project=` hash、文档 12 处、部署脚本 1 个。按以下顺序拆票（详见 issues/）：

| # | Ticket | 依赖 |
|---|--------|------|
| 01 | 契约层移除 Project，artifact 改挂 workspace | — |
| 02 | 持久化 schema 重写（改历史 migration + 清库策略） | 01 |
| 03 | 服务层去 Project（命令/校验/事件/错误码） | 01, 02 |
| 04 | 服务端目录浏览资源 | 01 |
| 05 | mac 式目录选择器组件 | 04 |
| 06 | workspace 界面重构（新建工作区对话框/导航/所有工作区页） | 03, 05 |
| 07 | 消费方插件界面去 Project（sessions/handoff/artifacts/workbench） | 03 |
| 08 | 测试迁移（fixture + 单测 + browser specs） | 03, 06, 07 |
| 09 | 文档与部署 | 06, 07 |

### 测试边界

- 使用真实 Host、插件与持久化；选择器行为经真实 Chromium 浏览器验证（单击/双击/前往文件夹/隐藏切换/截断提示/错误在位）。
- browse 资源单测覆盖：正常列出、symlink 标注、权限拒绝、不存在、截断、dotfiles 原样返回（过滤在前端）。
- 迁移策略验证：全新数据目录建库成功；含旧 checksum 的库启动报错信息指向清库指引。
- 全量单测与 browser specs 通过是 ticket 08 的验收线。

### 明确不做（v1）

- 不做选择器内新建文件夹（需服务端公开 mkdir，另行评估）。
- 不做数据迁移与旧库兼容读取。
- 不做多主体部署下的浏览授权收紧。
- 不恢复任何形式的 Project 或等效分组层。
