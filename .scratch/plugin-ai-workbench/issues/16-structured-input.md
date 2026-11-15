# 16: 按协商能力回答结构化问题

**What to build:** Agent 支持时，用户通过表单提交结构化信息；普通问句不会变成待处理交互。

**Blocked by:** 15: 一次性响应权限请求

**Status:** resolved

- [x] 只启用明确协商且实现支持的结构化输入扩展，保留字段约束和请求来源，不根据问号猜待回复。
- [x] 表单字段在浏览器和服务器校验，无效输入可修正且不消耗请求；成功响应复用权限工单的一次领取和活连接验证。
- [x] 不支持的请求显示能力限制或保留普通对话，不伪造可提交表单；未知扩展只提供受控诊断。
- [x] 刷新、取消、断线和多标签页下表单仍遵守 Interaction 的有效性及 delivery_unknown 语义。
- [x] 用支持与不支持两类 ACP 替身做浏览器行为测试；真实 Provider 的支持情况在其最终接入验收记录。

- [x] 结构化表单通过版本化公开 UI 契约替换，字段和可选操作来自有效请求；自定义控件不改变服务端字段约束、能力检查、领取规则或失效语义。

规格用户故事：26, 27, 74。

验收共识：遵循正式规格、领域词汇与已接受 ADR（含全界面公开替换契约 ADR-0004）；使用真实 Host、插件和持久化，经浏览器或公开命令/查询/事件及维护入口验证外部行为。ACP 协议替身仅用于外部 Agent 与故障控制，真实 Agent 验收不得被替代。

## Comments

- 2026-11-16：15 已完成独立复核及集成，本票按依赖进入实施。先核对稳定 ACP 与明确协商扩展的真实接口，再实现本机受支持／不支持两类协议和表单行为；不将普通问句视为待处理，不以受控 Agent 代替真实 Provider／Linux 验收。

- 2026-11-15：用户确认 36 张工单的拆分及依赖关系，按已评审草稿发布；本票尚未开始实施。

- 2026-11-15：按用户“第一项先做界面交互原型，交互确认后再完成功能开发”的决定，本票由原 15 顺延为 16；原验收范围与历史记录保留，原依赖按同一映射顺延。新 01“界面交互原型与用户确认”是本票的传递前置，用户确认交互前不得开始本票功能开发。

- 2026-11-15：结构化表单的外观与交互可替换，协议能力和服务端校验要求保持不变。尚未实施，原依赖及原型确认门禁不变。

## Answer

Local implementation is complete; Status remains claimed for root-owned independent review, integration and closure. The installed ACP SDK 2.7.0 default stable v1 natively exposes elicitation/create. Only Client form capability is advertised; no v2/unstable import or invented Agent support flag is used. Scope, bounded field subset, public commands/queries, replacement contracts and physical-writer/no-resend semantics are documented in [Structured work input](../../../docs/interactions/structured-input.md).

Ordinary questions remain chat. Unsupported URL/setup/auth/request-scope and unknown constraints have fixed diagnostics without raw sensitive request persistence or fake pending forms. Existing permission v1 contracts and independently installed permission UI remain compatible. Acceptance uses actual local Host/plugins/SQLite/HTTP/browsers/installed archives; only external ACP peers and fault timing are controlled. This does not establish real Claude/Codex, Linux or remote acceptance.

Validation on macOS with Node 24.22.3 / pnpm 10.30.2: full real Host suite **208/208 (19 files)** and full Chromium suite **59/59**, run sequentially against one stable built artifact. The new scope contributes 10 public Host cases and 7 browser cases; the accepted permission/queue/recovery suites remain green. Typecheck, build, dependency-boundary check and diff check pass. Exact author handoff and protocol evidence are recorded at `/tmp/aork-ticket-16-handoff.md` and `/tmp/aork-structured-input-protocol-plan.md`; real Provider/Linux/remote acceptance is not claimed.


Review correction (2026-11-16): fixed the independently identified old-epoch unprojected-fact replay window. A real fixture-only consumer, explicitly ordered before the enabled default Interactions plugin by a normal manifest dependency, SIGKILLs its own Host on the committed native pending fact. The public recovery probe proves the original pending fact replays from the prior epoch; pending/history/events now expose only expired and the stale response remains rejected. This is an actual crash/replay RED-to-GREEN test, not the already-projected restart case or a disabled-Interactions setup. No private database mutation or product fault hook was introduced. Post-fix targeted validation: 23/23 Host cases (structured forms, permissions, fact lifecycle) and 12/12 Chromium cases (forms and permissions). The prior full 208/59 counts above remain evidence for the earlier 23b4774 pin; they are not relabeled as a new full run.

### Integration acceptance — 2026-11-16

This supersedes the earlier author-checkpoint claimed status. Final `79a75f57d21b7768e142e9acba52a56121683873` received independent generic, TypeScript and security approval with zero outstanding findings. It was merged once as `8e3419c8a508d60c52d7766054ba4f19f491043e`; the primary tree exactly equals the approved tree. Fresh primary frozen installation, build, typecheck, boundaries and diff checks passed, followed by 23/23 public Host and 12/12 Chromium cases on the same build. Both the core Host and separately loaded corrected Interactions hashes match the approved artifacts. Evidence: `/tmp/aork-ticket16-merge.md` and the structured-input documentation. This ticket is resolved for its macOS/controlled-ACP scope; real Provider/Linux acceptance,17/24 and the wider specification remain separate.
