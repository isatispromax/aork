# 04: 三栏契约与浏览器验收、文档同步

**What to build:** 为新契约、偏好兼容、三区域扩展补测试；更新受影响的既有浏览器断言与部署脚本；同步文档。

**Blocked by:** 03: 左栏会话列表独立、文件视图进入右栏分区

**Status:** resolved

- [x] 单元：契约常量与 `readPreferences` 旧记录归一；manifest 校验接受 `aork.workbench.inspector@1` 与三个新扩展目标；profile 缺少 inspector 提供者时 doctor 报 `UI_PROVIDER_UNAVAILABLE`。
- [x] 浏览器：三栏同时可见；左栏工作区与会话为同级两段；右栏开关/加宽/关闭并在刷新后保留；<1150px 右栏为 dialog、Esc 后焦点回开关；<800px 左栏仍为 dialog。
- [x] 独立安装的 UI 夹具包（`tests/fixtures/workbench-view`）往 `aork.workbench.rail-sections@1`、`aork.workbench.conversation@1`、`aork.workbench.inspector-sections@1` 各贡献一个分区，断言三处同时可见且不覆盖默认内容；其 `Layout` 改为复用默认 `aork.workbench.inspector@1`。
- [x] 更新引用旧名称的既有断言：`切换文件面板`→`切换右侧栏`、`关闭文件面板`→`关闭右侧栏`、`切换文件面板宽度`→`切换右侧栏宽度`、右栏 dialog 名称 `会话文件`→`右侧栏`（`tests/browser/workbench.spec.ts`、`scoped-mcp-tools.spec.ts`、`negotiated-input.spec.ts`、`session-reconnect.spec.ts` 等）。
- [x] `deploy/linux/browser-check.mjs` 的 `workbench.savePreferences` payload 改用新字段。
- [x] 文档：`docs/workbench/navigation-and-reading.md`（组成表、偏好、窄屏）、`docs/sessions/history.md`（会话导航由布局装配）、README 工程边界表 `plugins/workbench` 一行。
- [x] `pnpm typecheck`、`pnpm check:boundaries`、定向 `vitest`、定向 Playwright 全绿。

规格：Implementation Decisions「验收边界」。
