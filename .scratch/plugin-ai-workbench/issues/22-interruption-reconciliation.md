# 22: 崩溃和重启后的运行核对

**What to build:** Agent 崩溃或 Host 重启后，用户看到中断或交付不确定的准确状态，旧请求失效，旧占用经核对后处理。

**Blocked by:** 13: 后续输入排队与显式继续, 14: 浏览器断线后的状态恢复, 15: 一次性响应权限请求

**Status:** resolved

- [x] 补齐启动核对流程：单实例锁、暂停调度、持久暂停受影响 Session、核对旧进程身份、清理、标记结果和失效交互；不是此时才开始阻止重复运行。
- [x] attempting 且没有确定结果的输入不重发；queued 工作也保持暂停，浏览器重连不触发派发。
- [x] 保留已落库文本、工作区文件和关联信息，区分 adapter 退出、受管停止与进程身份未知。
- [x] 不能仅凭旧 PID 杀进程；不能确认写入停止则 Claim 保持 blocked，UI 给出诊断及明确的后续动作。
- [x] 公开故障测试覆盖 adapter 退出、Host 重启、重复启动、发送窗口崩溃和旧交互响应；已有等待/取消中状态正确收束。

规格用户故事：34, 36, 37, 38。

验收共识：遵循正式规格、领域词汇与已接受 ADR（含全界面公开替换契约 ADR-0004）；使用真实 Host、插件和持久化，经浏览器或公开命令/查询/事件及维护入口验证外部行为。ACP 协议替身仅用于外部 Agent 与故障控制，真实 Agent 验收不得被替代。

## Answer — 2026-11-16

核心实现已合入 `codex/plugin-ai-workbench`，批准源 `537d5fb40282d5cef1304b444ebee293e87b137e`，一次合并 `be32bfe04cbe3a1d47b43a0d08775524519fcb5d`，集成树与批准源完全一致。启动先取得既有 OS 锁，完成事实追赶、持久暂停、准确中断分类、旧权限／原生表单失效及有限核对，再开放调度与监听。原输入、附件副本、文件、原生引用和不可变回执保留；已尝试而结果不确定的操作不重发，已核对停止也不自动继续队列。

公开 `sessions.reconciliation` 与 `sessions.recheckRun` 仅接受授权 Run 查找，浏览器没有 PID、owner、proof 或强制释放权限。Runtime 通过实际选定调用者绑定的不透明准备／应用，在事务外只读观察、事务内共同提交 Runtime／Sessions／Claim／事件／回执。只用信号0观察记录的组，不向旧编号发送终止信号；组存在、身份缺失、旧数据覆盖不全或工作／参与者无法确认时继续 blocked。组消失仅结合事前完整的受管写入覆盖才作为停止证据；5秒准备有效期仅限制授权新鲜度，不表示执行停止。

新增可选、位于 Runtime 下游的 `aork.execution.writers@1` 参与接口，事前记录 owner／版本／覆盖，准备与应用重新验证，缺失必需参与者时核对及正常停止均保守拒绝释放。此处验收为核心 ACP／独立参与者路径，真实24 Tools 提供者尚未合入，后续必须作真实联合验证，不将撤销令牌或新 Host 内存为空冒充停止证明。

已修复两项独立复核问题：检查历史 Run 不再暂停新一代已继续的队列；Interactions 先追赶已落库终态再作缺失回退，权限和表单在已受理未尝试、实际发送窗口、已写入而未投影三类崩溃中分别只发布一次正确的 expired／delivery_unknown／responded。generic、TypeScript、security 最终独立复核均无遗留发现。作者修复后80个 Host、14个浏览器及构建检查通过；主工作区另行通过15个 Host、2个浏览器和冻结安装／构建／类型／边界／差异检查。记录见 `docs/sessions/interruption-reconciliation.md`、`/tmp/aork-ticket-22-handoff.md`、`/tmp/aork-ticket22-merge.md`。本票核心 resolved；实际 Tools 联合、23 原生恢复、Linux／真实 Provider 等按后续票验证。

## Comments

- 2026-11-16：13／14／15 已完成并持续通过17组合验证，本票开始核对接口和实施。继续先在本机 macOS 验证；旧 PID、超时或心跳不构成停止证明，无法确认的占用保留 blocked 并提供明确诊断及操作路径，不自动重发原输入或继续队列。

- 2026-11-15：用户确认 36 张工单的拆分及依赖关系，按已评审草稿发布；本票尚未开始实施。

- 2026-11-15：按用户“第一项先做界面交互原型，交互确认后再完成功能开发”的决定，本票由原 21 顺延为 22；原验收范围与历史记录保留，原依赖按同一映射顺延。新 01“界面交互原型与用户确认”是本票的传递前置，用户确认交互前不得开始本票功能开发。

- 2026-11-16 implementation checkpoint (claimed; root acceptance pending): new public `sessions.reconciliation` / `sessions.recheckRun`, scoped opaque Runtime preparation/apply, signal0-only Runner observation, awaited startup before scheduling, preserved original operation evidence and new-run durable writer coverage. Public RED/GREEN tests and precise local evidence/unsupported fault windows are documented in `docs/sessions/interruption-reconciliation.md`. Final participant integration and independent review remain pending; this comment does not resolve the ticket.

- 2026-11-16 review repair checkpoint (still claimed): public two-generation regression reproduced a historical stopped Run check pausing a newer explicitly resumed queue; reconciliation now gates queue mutation against the current generation inside the apply transaction. Public response fault cases reproduced an invented `delivery_unknown` before an unprojected definitive `responded`; Interactions now catches up Runtime facts before fallback invalidation. Six permission/form response crash cases cover unattempted expiry, actual blocked-writer delivery uncertainty and committed-unprojected definitive response, each with one correct terminal event. Root final generic/TypeScript/security review remains pending.
