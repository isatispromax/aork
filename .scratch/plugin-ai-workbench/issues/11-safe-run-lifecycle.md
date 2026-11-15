# 11: 准备与结束运行，落实工作区占用

**What to build:** 用户从 Session 启动一个 ACP Run 至 ready，看到版本、目录和能力，再结束运行；重叠目录始终只有一个写入所有者。

**Blocked by:** 06: 配置、启停与恢复插件, 08: 浏览和操作工作区文件, 10: 创建会话并查看历史索引

**Status:** resolved

- [x] 持有 Host 单实例锁后，原子受理 Workspace Claim、Run 和启动操作；进程启动在提交后，Runtime 不改写 sessions 私有数据；运行事实投影与消费 offset 同事务提交。
- [x] 通过 ACP 测试进程执行 initialize 与原生会话创建，记录连接代次、版本、受控环境和原生状态引用；不开放 prompt。
- [x] 真实目录别名及祖先/后代重叠互斥；ready 状态持有 Claim，文件服务的并发写入也遵守同一所有权规则。
- [x] 结束 Run 先停止受管进程和登记任务，确认后释放；不确定时 blocked 并可诊断，不按 TTL、心跳或旧 PID 擅自释放或杀进程。 不支持原生恢复的 Agent 不自动休眠，用户结束时明确提示下次需要新建原生会话。
- [x] Host 再启动先封闭旧 Run，暂停派发，未知 Claim 不让位；插件生命周期注册当前使用关系，防止绕过启停门禁。
- [x] 浏览器可演示启动与结束；公开接口并发测试占用和失败，子进程只获所需环境；界面明确占用不构成 OS 沙箱。

规格用户故事：9, 10, 15, 33, 34, 72。

验收共识：遵循正式规格、领域词汇与已接受 ADR（含全界面公开替换契约 ADR-0004）；使用真实 Host、插件和持久化，经浏览器或公开命令/查询/事件及维护入口验证外部行为。ACP 协议替身仅用于外部 Agent 与故障控制，真实 Agent 验收不得被替代。

## Comments

- 2026-11-15：用户确认 36 张工单的拆分及依赖关系，按已评审草稿发布；本票尚未开始实施。

- 2026-11-15：按用户“第一项先做界面交互原型，交互确认后再完成功能开发”的决定，本票由原 10 顺延为 11；原验收范围与历史记录保留，原依赖按同一映射顺延。新 01“界面交互原型与用户确认”是本票的传递前置，用户确认交互前不得开始本票功能开发。


## Answer

Implemented the complete local macOS Run preparation/end slice. Production is frozen at `abb4934254251a52843eba71e1bf6e9885ecf2aa`; final documentation pin `f43bb6b966b4a64fd71912ba27bfa80c0443a8ae` was independently approved and merged as `e01154203c34f66181364a4f008fef703ef86489`. All confirmed review findings are closed; final security review has no confirmed finding. Fresh primary offline install, build, typecheck, boundaries, diff check and five public lifecycle regressions pass. Ticket 11 is resolved; no real Claude/Codex or Linux acceptance is implied.

- Real public `sessions.startRun({sessionId})` and `sessions.endRun({runId})` commands, replaceable Session detail controls and authoritative queries distinguish accepted/starting from ACP-ready and confirmed-stopped. Ready retains ownership; browser disconnect does not stop a Run. End warns that another start creates a new native context.
- One short shared transaction records a persistent Workspace Claim, Session-owned Run, Runtime-owned start intent, receipt and browser event. The actual asynchronous Workspace write gate surrounds preparation and commit. The opaque permit is tied to the active callback, current owner/epoch and exact reservation transaction; it cannot be reconstructed from browser data or reused in another transaction. Start retries deduplicate before writer admission.
- Independent server-only Runner/Runtime packages perform actual POSIX group supervision and ACP SDK 2.7.0 stable-v1 initialize/session.new. Attempting precedes external effects; there is no prompt/load/MCP/Turn endpoint. Runtime writes only its own operation/facts. Sessions projection, sanitized event, consumer offset and final Claim release share a transaction. Consumer fact sources have no producer append authority.
- Host-issued immutable owner records and consumer-bound service facades keep actual Provider ownership in the Run usage snapshot. Saved Profile revision/configuration and current canonical directory/state/binary/version are revalidated. Only supported none-auth launches are enabled here; credentials remain references and arbitrary Host environment/stderr/RPC payloads never become durable Run values.
- Alias/device/inode/ancestor/descendant Claims protect Files and starts, including after restart with Runtime disabled. Unknown prior epochs are fenced before listen, with no uncertain replay, TTL release or stored-PID kill. Active/unknown archival and used-owner lifecycle changes are refused; unrelated roots and pure UI composition remain usable.
- Stop waits for the actual leader/group plus registered cancellation acknowledgment, including surviving child escalation, rejected/hanging jobs and automatic connection-loss stop already in progress. Optional Agent-reported metadata stays absent/unknown when ACP omits it; detected binary version remains a separate observation. Ready Runs hold no lifetime HTTP lease. Ordinary revoked callbacks cannot borrow an unrelated teardown's async write scope; owned teardown joins work and flushes confirmed terminal outcomes through its expiring cleanup scope.

Verification: actual macOS 27.2.1/26B131 arm64, Node 24.22.3 ABI137, pnpm 10.30.2. Frozen install, build, strict typecheck, dependency boundaries and diff check pass. Full Host suite **150/150** across 14 files and full Chromium **30/30** pass on the frozen production source. Public tests cover real Host/Plugins/SQLite/HTTP/local maintenance; only the external ACP Agent, actual filesystem timing/failure and offline standard SQLite counter restoration boundaries are controlled fixtures; no private-table assertions or product test backdoors are used. Desktop and 390px screenshots were inspected at `/tmp/aork-ticket11-run.png` and `/tmp/aork-ticket11-run-mobile.png`.

Early review identified and repaired receipt admission dedupe, fact producer/consumer authority separation, Provider owner attribution, unsupported protocol negotiation, reconfigure/cleanup scope handling and shutdown races. The permanent public regressions include split-transaction/claimless admission, actual process liveness after a rejected forged stopped fact, used owner disable refusal, asynchronous transaction rejection, actual SQLite failure/redaction, delayed Files synchronization, all restart/stop cases above, and immutable saved Profile revision rejection. Final R11-01/02/03 repairs additionally preserve admitted producers while early lifecycle authorities await, pause/resume facts through busy refusal and successful reactivation, flush shutdown outcomes from Runtime-owned cleanup even when a dependent initiated stop, and preserve exact bigint offsets above JavaScript integer precision.

Product documentation: [Run lifecycle](../../../docs/sessions/run-lifecycle.md), [Session history](../../../docs/sessions/history.md), README. No real Claude/Codex login/conversation, native load, Linux/remote deployment, upgrade, backup/restore or escaped-child containment acceptance is claimed. There is no force-release command for unknown Claims. No integration merge, push, deployment or worktree archive was performed by this worker; prototype4317 was untouched.
