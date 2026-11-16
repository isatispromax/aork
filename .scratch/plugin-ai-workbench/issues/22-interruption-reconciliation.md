# 22: 崩溃和重启后的运行核对

**What to build:** Agent 崩溃或 Host 重启后，用户看到中断或交付不确定的准确状态，旧请求失效，旧占用经核对后处理。

**Blocked by:** 13: 后续输入排队与显式继续, 14: 浏览器断线后的状态恢复, 15: 一次性响应权限请求

**Status:** claimed

- [ ] 补齐启动核对流程：单实例锁、暂停调度、持久暂停受影响 Session、核对旧进程身份、清理、标记结果和失效交互；不是此时才开始阻止重复运行。
- [ ] attempting 且没有确定结果的输入不重发；queued 工作也保持暂停，浏览器重连不触发派发。
- [ ] 保留已落库文本、工作区文件和关联信息，区分 adapter 退出、受管停止与进程身份未知。
- [ ] 不能仅凭旧 PID 杀进程；不能确认写入停止则 Claim 保持 blocked，UI 给出诊断及明确的后续动作。
- [ ] 公开故障测试覆盖 adapter 退出、Host 重启、重复启动、发送窗口崩溃和旧交互响应；已有等待/取消中状态正确收束。

规格用户故事：34, 36, 37, 38。

验收共识：遵循正式规格、领域词汇与已接受 ADR（含全界面公开替换契约 ADR-0004）；使用真实 Host、插件和持久化，经浏览器或公开命令/查询/事件及维护入口验证外部行为。ACP 协议替身仅用于外部 Agent 与故障控制，真实 Agent 验收不得被替代。

## Comments

- 2026-11-16：13／14／15 已完成并持续通过17组合验证，本票开始核对接口和实施。继续先在本机 macOS 验证；旧 PID、超时或心跳不构成停止证明，无法确认的占用保留 blocked 并提供明确诊断及操作路径，不自动重发原输入或继续队列。

- 2026-11-15：用户确认 36 张工单的拆分及依赖关系，按已评审草稿发布；本票尚未开始实施。

- 2026-11-15：按用户“第一项先做界面交互原型，交互确认后再完成功能开发”的决定，本票由原 21 顺延为 22；原验收范围与历史记录保留，原依赖按同一映射顺延。新 01“界面交互原型与用户确认”是本票的传递前置，用户确认交互前不得开始本票功能开发。

- 2026-11-16 implementation checkpoint (claimed; root acceptance pending): new public `sessions.reconciliation` / `sessions.recheckRun`, scoped opaque Runtime preparation/apply, signal0-only Runner observation, awaited startup before scheduling, preserved original operation evidence and new-run durable writer coverage. Public RED/GREEN tests and precise local evidence/unsupported fault windows are documented in `docs/sessions/interruption-reconciliation.md`. Final participant integration and independent review remain pending; this comment does not resolve the ticket.
