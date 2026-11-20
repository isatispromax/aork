# 27: 复用成果与关联新会话

**What to build:** 用户选择文件、摘要或 Artifact 版本继续工作，或切换 Agent 创建带来源关联的新 Session。

**Blocked by:** 17: 按 Agent 能力配置输入和参数, 25: 登记、预览和下载产物版本

**Status:** resolved

- [x] 从现有结果或不可恢复历史进入关联新会话，选择目标 Profile/Workspace，并明确选取携带内容。
- [x] 保留旧 Session 和来源关系，不跨 Provider 复用原生会话 ID，不宣称无损上下文迁移。
- [x] 同一会话也可把 Artifact 版本再次作为输入，服从 Agent 协商能力和访问范围；大内容通过受控引用处理。
- [x] 只携带用户选择的内容，版本不存在、无权限或输入不支持时给出可修正错误；重试命令不重复创建 Session/Turn。
- [x] 浏览器验证同会话复用、换 Provider、无原生恢复能力和错误引用；本票不依赖原生恢复实现完成。

规格用户故事：41, 42, 50。

验收共识：遵循正式规格、领域词汇与已接受 ADR（含全界面公开替换契约 ADR-0004）；使用真实 Host、插件和持久化，经浏览器或公开命令/查询/事件及维护入口验证外部行为。ACP 协议替身仅用于外部 Agent 与故障控制，真实 Agent 验收不得被替代。

## Answer — 2026-11-20

`sessions.createLinked`（durable command）从任意已有 Session（含已归档或不可原生恢复的历史）创建带 `linkedFrom` 来源引用的新 Session，并保存不可变 handoff 记录（`pending`）。目标 Project/Workspace/Agent Profile 由用户显式选择（可换 Provider）；只携带用户明确选取的摘要文本（≤16000 字符，成为新会话首条输入文本）、最多 4 个工作区文件与 Artifact 版本（`tests/context-handoff.test.ts` 断言 carry 只含所选项）。跨工作区文件经公开 Workspace 写入路径复制到确定性受控路径 `.aork-handoff-<hash>-<name>`，重试同命令按内容校验幂等；不复制任何原生会话标识。

来源关系双向可见：新 Session 在 `sessions.overview` 报告 `linkedFrom`，来源 Session 报告 `linkedTo` 后继；来源的输入时间线、产物关联（`artifacts.list?sessionId=`）与运行记录保持可读（测试 1、浏览器测试 2）。`sessions.sendHandoff`（durable command）在该 Session 的 Run `ready` 后把存量选择捕获为第一条输入：服从该 Run 协商能力与内联字节限制，同一事务内把记录置为 `sent`（含 turnId）；失败（能力/格式/超大）保持 `pending` 并给可修正错误。测试断言新 Session 的首个 Run 走全新 `session/new`，wire 上从不出现 `session/load`，同 commandId 重试返回原回执且 wire 只有一条 prompt。

同会话复用：`sessions.sendText` 附件扩展为 `{artifactVersionId, kind}` 联合类型；受理时经 artifacts 插件在 `aork.sessions@1` 上注册的 owner seam（`registerArtifactVersions`，避免 artifacts↔sessions 依赖环）读取不可变版本字节并核对 sha256，访问范围为主体验证的所有权。错误矩阵（未知版本 404、外部引用 409、格式 415、超大 413）均为可修正错误且不产生 Turn。大内容走受控引用：`artifacts.exposeVersion` 把不可变版本字节物化到确定性工作区路径 `.aork-artifact-<id>-<version>-<name>`（占用中的工作区拒绝 `WORKSPACE_WRITE_BUSY`；重复 expose 幂等校验同字节）。

UI：新公开独占视图契约 `aork.sessions.handoff@1`（profile 显式选择，UI_CONTRACTS 已注册）承载交接对话框（菜单“交接到新会话…”入口，含无原生恢复提示）；会话详情显示关联横幅与待发送/已发送交接面板；artifacts 插件经 `aork.sessions.input-extensions@1` 扩展点贡献“添加产物版本作为输入”，预览视图提供“放入工作区（受控引用）”。所有界面文案明确“上下文交接不是原生恢复，不迁移原生历史，不跨 Provider 复用原生会话 ID”。

验证（Node 24.22.3，branch codex/aork-27，合并集成分支 3920722 后）：`pnpm build`、`pnpm typecheck`、`node scripts/check-boundaries.mjs` 通过；`tests/context-handoff.test.ts` 8/8（双向关联与来源完整、携带错误矩阵、单次投递＋全新原生会话＋无 session/load、跨工作区受控复制、能力拒绝保持 pending、同会话产物复用与附件错误矩阵、受控 expose 幂等与占用拒绝）；`tests/browser/context-handoff.spec.ts` 2/2（同会话复用；换 Provider 交接＋无原生恢复入口＋失效文件引用在对话框内修正后成功）。回归：artifact-versions 6/6＋浏览器 2/2、artifact-renderers 3/3＋浏览器 3/3、sessions、negotiated-input、turn-streaming、bootstrap、native-recovery、workbench、queued-turns、large-input-timeline、structured-input、interruption-reconciliation 全绿（共 110+ 用例）；snapshot-reconnect 一次共享负载超时后单独重跑 9/9。真实 Claude/Codex 远程验收与 Linux 部署仍属后续工单。

## Comments

- 2026-11-20：实施完成。要点：sessions↔artifacts 无依赖环（artifacts 在 sessions 服务上注册版本读取 seam）；handoff 记录 pending→sent 与 Turn 同事务；关联双向经 `sessions.overview` 公开投影；附件联合契约（工作区文件 | Artifact 版本）由 sessions 在受理时统一能力/大小/校验。合并 3920722（工单 21/26）时保留双方：artifacts manifest 同时含 html renderer 提供者与 input 扩展，Preview 以工单 26 渲染器版为基并保留放入工作区入口。文档 `docs/sessions/handoff.md`、history 更新、GLOSSARY 增加上下文交接词条。

- 2026-11-15：用户确认 36 张工单的拆分及依赖关系，按已评审草稿发布；本票尚未开始实施。

- 2026-11-15：按用户“第一项先做界面交互原型，交互确认后再完成功能开发”的决定，本票由原 26 顺延为 27；原验收范围与历史记录保留，原依赖按同一映射顺延。新 01“界面交互原型与用户确认”是本票的传递前置，用户确认交互前不得开始本票功能开发。
