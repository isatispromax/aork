# 06: workspace 界面重构（新建工作区对话框 / 导航 / 所有工作区页）

**What to build:** `plugins/workspace/src/client.tsx` 与 `file-view.tsx` 去 Project 并接入目录选择器，形成 workspace-first 界面。

**Blocked by:** 03: 服务层去 Project；05: mac 式目录选择器组件

**Status:** resolved

- [x] 新建工作区对话框 = 名称 + 目录选择器（ticket 05 组件）+ 访问权限（可读写/只读，默认可读写）+「授权此目录及其子目录」checkbox；managed 分支与「目录管理」下拉删除；提交走 `workspace.create`（新契约，无 projectId）。
- [x] 左侧导航：项目树改单层工作区列表，`aria-label` 改「工作区导航」，h1 改「工作区」，`＋` 按钮改「新建工作区」（L84-88）。
- [x] 「所有项目」页改造为「所有工作区」页（grilling Q13）：卡片显示工作区名、目录路径、状态、会话数；按钮与空状态文案全部去「项目」（L90-122）。
- [x] 项目详情页与 `editProject`/`archiveProject` 三态删除；编辑工作区仍仅改名；归档工作区入口保留（L123-126）。
- [x] `project-page` 视图注册与 `Page` 分支删除（L134-135）；`profiles/personal-server.json` L124 的视图映射移除。
- [x] 全部「项目」相关文案改写（L19/23/24/56/87/93/97/98/116/123-126），含空状态「项目不可用/为下一项工作留个空间」等。
- [x] `file-view.tsx` L61 可写判定改为仅看 workspace 状态。
- [x] URL 选中态按新契约（无 project 键）读写。

规格用户故事：1, 2, 6。

验收共识：遵循正式规格、ADR-0004（可替换 UI 契约）与 ADR-0005；对话框错误停留重试机制保留；经真实 Chromium 手测新建/编辑/归档/刷新恢复全流程。

## Comments

- 2026-11-21：grilling Q14 决定保留只读权限与授权 checkbox（默认可读写）——授权确认是产品安全模型的一部分，不因换选择器而静默化。

- 2026-11-22：实施于 `codex/workspace-first`（`528b40c`，merge `1ccf7de`；迁移闸门暴露的跨 tab 回归修复 `1f127e1`、`6ba2c66`）。新建工作区对话框（名称+目录选择器+访问权限+授权 checkbox）、单层工作区导航、所有工作区页卡片（名称/目录/状态/会话数）、`project-page` 视图注册删除均落地；`file-view` 可写判定仅看 workspace 状态；对话框错误停留重试机制保留；浏览器 specs 全绿。本票 resolved。

- 2026-11-22：部分被 `.scratch/native-picker` 取代——访问权限 select 与授权 checkbox 连同 Workspace access 概念整体移除，目录选择改为「手输输入框 + 原生选择…按钮」。grilling Q14 的决定（授权确认是安全模型一部分）随之作废。

