# 06: workspace 界面重构（新建工作区对话框 / 导航 / 所有工作区页）

**What to build:** `plugins/workspace/src/client.tsx` 与 `file-view.tsx` 去 Project 并接入目录选择器，形成 workspace-first 界面。

**Blocked by:** 03: 服务层去 Project；05: mac 式目录选择器组件

**Status:** ready-for-agent

- [ ] 新建工作区对话框 = 名称 + 目录选择器（ticket 05 组件）+ 访问权限（可读写/只读，默认可读写）+「授权此目录及其子目录」checkbox；managed 分支与「目录管理」下拉删除；提交走 `workspace.create`（新契约，无 projectId）。
- [ ] 左侧导航：项目树改单层工作区列表，`aria-label` 改「工作区导航」，h1 改「工作区」，`＋` 按钮改「新建工作区」（L84-88）。
- [ ] 「所有项目」页改造为「所有工作区」页（grilling Q13）：卡片显示工作区名、目录路径、状态、会话数；按钮与空状态文案全部去「项目」（L90-122）。
- [ ] 项目详情页与 `editProject`/`archiveProject` 三态删除；编辑工作区仍仅改名；归档工作区入口保留（L123-126）。
- [ ] `project-page` 视图注册与 `Page` 分支删除（L134-135）；`profiles/personal-server.json` L124 的视图映射移除。
- [ ] 全部「项目」相关文案改写（L19/23/24/56/87/93/97/98/116/123-126），含空状态「项目不可用/为下一项工作留个空间」等。
- [ ] `file-view.tsx` L61 可写判定改为仅看 workspace 状态。
- [ ] URL 选中态按新契约（无 project 键）读写。

规格用户故事：1, 2, 6。

验收共识：遵循正式规格、ADR-0004（可替换 UI 契约）与 ADR-0005；对话框错误停留重试机制保留；经真实 Chromium 手测新建/编辑/归档/刷新恢复全流程。

## Comments

- 2026-11-21：grilling Q14 决定保留只读权限与授权 checkbox（默认可读写）——授权确认是产品安全模型的一部分，不因换选择器而静默化。
