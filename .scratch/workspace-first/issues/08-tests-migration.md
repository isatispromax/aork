# 08: 测试迁移（fixture + 单测 + browser specs）

**What to build:** 全部测试从 project 导航迁移到 workspace-first，并覆盖目录选择器与 browse 资源的浏览器行为。

**Blocked by:** 03: 服务层去 Project；06: workspace 界面重构；07: 消费方插件界面去 Project

**Status:** ready-for-agent

- [ ] `tests/fixtures/session-host.ts`：`sessionEnvironment` 改为直接建 workspace（新 `workspace.create` 路径），返回输入去 projectId（L70-77）——牵动约 20 个单测文件的公共环境。
- [ ] `tests/projects-workspaces.test.ts`：重写为 workspace-only（注册校验、幂等去重、目录校验、归档），删 project 用例。
- [ ] 直接依赖单测去 projectId：sessions、workbench、run-lifecycle、context-handoff、artifact-versions（第二个 project 的 ownership/mismatch 用例改双 workspace）、artifact-renderers、workspace-files、provider-claude、provider-codex、provider-launch-environment。
- [ ] 18 个 browser spec 直写 `project=` 的 hash 行改写为 workspace 键（逐文件清单见爆炸半径报告 §5）；`projects-workspaces.spec.ts` 重写为 workspace-first（含新建工作区对话框 + 目录选择器全流程）；`workspace-files.spec.ts` L11 的 UI 建项目流程改直接建工作区。
- [ ] sessions.spec.ts L117「伪 project 不匹配守卫」用例删除或改为对应 workspace 场景。
- [ ] fixture 替换 UI 去 projectId：`tests/fixtures/session-view/src/client.tsx`（读 hash `project`）、`artifacts-view`、`planned-run-owner/src/server.ts`。
- [ ] 新增目录选择器 browser 覆盖：单击选中/双击进入/选择确认（含未选中=当前目录）/前往文件夹/隐藏切换/错误在位重试。
- [ ] 全量 Vitest 单测与 browser specs 通过。

规格用户故事：1-9。

验收共识：遵循正式规格与 ADR-0005；测试环境用真实 Host 与真实 Chromium；验证数据可弃路径（全新数据目录建库）与旧库报错信息。

## Comments

- 2026-11-21：本票是回归闸门；fixture 是最大单点，先改 fixture 再逐文件跑绿。
