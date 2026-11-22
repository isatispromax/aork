# 09: 文档与部署收尾

**What to build:** 文档词汇全面切换到 workspace-first，补「升级需清空数据目录」说明，部署校验脚本去 project。

**Blocked by:** 06: workspace 界面重构；07: 消费方插件界面去 Project

**Status:** resolved

- [x] `README.md`：首段（L3）、「项目与工作区」章节（L35-37）、插件表（L92）重写为 workspace 表述；新增升级说明：本次 schema 变更不迁移，升级需清空数据目录（含外部目录登记路径需自行备份记录）。
- [x] `docs/workspace/projects-and-workspaces.md`：重写为 workspaces.md——命令表删 createProject/editProject/archiveProject，`workspace.create` 新形态，browse 资源说明，目录选择器交互。
- [x] `docs/sessions/history.md`（L3/5/11/27）、`docs/artifacts/versions.md`（L3/5/25/35）、`docs/workbench/navigation-and-reading.md`（L9/28-29/41）、`docs/workspace/files.md`（L36）、`docs/sessions/turns.md`（L21）、`docs/interactions/permissions.md`（L9）、`docs/interactions/structured-input.md`（L9）相应段落去 project。
- [x] `deploy/README.md` L47 与 `deploy/linux/command-check.mjs` L86-95：校验脚本改直接 `workspace.create`（不再建 project）。
- [x] `GLOSSARY.md` 已由 grilling 会话同步更新（本票只核对文档与词汇一致，不改词条）。

规格用户故事：1, 2, 9。

验收共识：遵循正式规格与 ADR-0005；所有文档不再出现作为领域概念的「项目/Project」；清库升级说明在 README 与 workspaces.md 双处可见。

## Comments

- 2026-11-21：GLOSSARY 与 ADR-0005 随 grilling 收敛已落盘；本票处理其余 12 处文档与 2 处部署面。

- 2026-11-22：实施于 `codex/workspace-first`（`646bd68`，merge `9334b38`）。README 首段/工作区章节/插件表改 workspace 表述并加入「升级需清空数据目录」说明（与 `docs/workspace/workspaces.md` 双处可见）；`deploy/linux/command-check.mjs` 与 `deploy/README.md` 改直建 workspace；GLOSSARY 词汇一致性核对通过；文档 grep 无残留的领域概念「项目/Project」。本票 resolved。
