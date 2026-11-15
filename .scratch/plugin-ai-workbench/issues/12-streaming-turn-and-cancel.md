# 12: 完成文本执行轮次并随时取消

**What to build:** 用户发送文本，看到持久化流式回答和工具报告，并能在长 prompt 中取消；完成后可继续下一轮。

**Blocked by:** 11: 准备与结束运行，落实工作区占用

**Status:** claimed

- [x] 输入、Turn、用户消息和回执先持久化；副作用前记录 attempting，返回受理与执行成功分开；一次 Session 最多一个 prompt，本票运行中新增输入明确拒绝而不偷偷并发。
- [x] 文本有界落库后推送，工具报告只呈现不重复执行；无真实费用或用量数据时显示未知。
- [x] 长 prompt 不阻塞控制操作；取消先关闭新响应通道，显示 cancelling 直到真实终止，超时使用既有受管停止；取消 Turn 不自动释放仍活跃 Run 的 Claim。
- [x] 区分发送窗口缺少确定交付结果与已知执行中的连接中断，按事实显示 delivery_unknown 或 interrupted 并保留停止原因，两者都不自动重发；关键写入失败停止接单并阻断或终止受影响 Run。
- [x] 通过 Runtime 持久事实建立 interactions 所有的最小 pending 投影，按 run/generation 关联并展示等待和取消；投影更新与消费 offset 同事务提交。本票不提供批准/拒绝入口，不自动或超时批准，后续权限工单补充响应。
- [x] 浏览器关闭不会结束 Run；用 ACP 替身经完整 Host 验证成功、工具报告、取消、等待权限和发送窗口故障。

- [x] composer、消息和工具状态均通过公开可替换 UI 契约提供，输入／取消只调用 sessions 公开命令；替换呈现不得重复提交、猜测完成、放行并发 prompt 或绕过服务端运行约束。

规格用户故事：3, 16, 17, 20, 21, 23, 25, 31, 32, 74。

验收共识：遵循正式规格、领域词汇与已接受 ADR（含全界面公开替换契约 ADR-0004）；使用真实 Host、插件和持久化，经浏览器或公开命令/查询/事件及维护入口验证外部行为。ACP 协议替身仅用于外部 Agent 与故障控制，真实 Agent 验收不得被替代。

## Comments

- 2026-11-15：用户确认 36 张工单的拆分及依赖关系，按已评审草稿发布；本票尚未开始实施。

- 2026-11-15：按用户“第一项先做界面交互原型，交互确认后再完成功能开发”的决定，本票由原 11 顺延为 12；原验收范围与历史记录保留，原依赖按同一映射顺延。新 01“界面交互原型与用户确认”是本票的传递前置，用户确认交互前不得开始本票功能开发。

- 2026-11-15：输入区和消息作为可独立替换视图实施，不把正常业务逻辑放进 UI 或宿主 Shell。尚未实施，原依赖及原型确认门禁不变。


## Answer

2026-11-16：本票完整本机切片已实现并验证，保留 claimed 供主代理完成集成关闭。生产冻结提交为 `7c4a9a8904c5ff806a1662032a564bceab7e4061`，分支 `codex/aork-12`。没有部署、推送或远程 Agent 操作。

- `sessions.sendText` 先原子保存 Turn、用户原文、浏览器事件及不可变回执；独立派发事务保存 Runtime intent，实际 ACP prompt 前提交 attempting。相同 commandId 原回执先于 busy 校验；不同并发输入只能受理一条。空白与 UTF-8 保留，输入及序列化消息容量均有界。
- Runtime 的短持久化/控制通路与 prompt、permission deferred 分离。顺序事实先落库，Sessions 时间线、工具显示及事件与消费 offset 同事务更新。工具文字只显示，rawInput/rawOutput/_meta/思考及原生错误 data 不进入普通投影。真实上下文用量/可选会话费用按 Agent 报告保存；缺失显示未知。
- `sessions.cancelTurn` 关闭新权限响应通道、失效并取消现有通道后发送语义 cancel，保持 cancelling 至原 prompt 真实结果或受管停止证明。协作取消保留 ready Run 与 Claim；完成赢得竞争时保留实际 stopReason；宽限后走既有受管停止并保留真实原因。结束、关闭 Host、依赖先调用 shutdown 的清理均加入实际 prompt/队列/进程证明，并从 Runtime 自有清理域重试终态持久化。
- 独立 `interactions` 插件拥有最小 pending 投影，按 Run/generation/Turn/native Session/typed request ID 关联。普通文本问句不计 pending；本票没有批准、拒绝、respond 或超时批准 API。过量/超大请求在登记前关闭对应连接并停止受影响 Run。公共 ACP Stream 在 SDK 入站前限制所有待响应 RPC（64 个/2MiB 序列化请求），仅在底层响应写完后释放预算，覆盖未知方法、拒绝/失效请求及停止读取响应的 Agent。
- 无已保存 Agent 进展的尝试窗口断线为 delivery_unknown，有已保存进展为 interrupted；明确 RPC 错误为 failed。重启保留输入、失效旧 Interaction、暂停派发且不重发；Runtime 停用时根据 Sessions 自有持久证据保守分类。关键写入失败停止接单并停止/阻断受影响执行，队列溢出不阻断其他健康 Run。已归档历史继续可读，历史资源对消息、工具和 Turn 整体序列化限额裁剪并明确 truncated，不删除保存内容。
- 默认 Detail 经公开 `aork.sessions.composer@1`、`aork.sessions.messages@1`、`aork.sessions.tools@1` 组合；manifest/profile 显式选定。浏览器覆盖 IME、Shift+Enter、多行原文、跨刷新草稿与原 commandId 重试、权限等待/真实取消、最新跨标签页 Turn、390px 及独立 UI 包在固定 Host 构建上的三个子视图替换。

实际验证：macOS Darwin27.2.0 arm64；Node24.22.3（ABI137）、pnpm10.30.2、ACP SDK2.7.0/stable wire v1。冻结产物的严格 typecheck、build、边界检查和 diff 检查均通过；**171/171 Host 测试（15 文件）及35/35 Chromium 测试通过**。其中21条新增真实 Host Turn 用例经实际 Runner、SQLite、HTTP/事件/维护及外部 ACP 进程完成。Runtime 与 Interactions 独立归档构建通过。没有 Runner/storage mock 或私有表断言。

独立 TypeScript/界面审查与安全审查在冻结源码复查后无未解决问题；报告 `/tmp/aork-ticket12-final-review.md`、`/tmp/aork-ticket12-final-security-review.md`。审查发现的明确 RPC 错误分类、结束前派发围栏、权限整体大小、SDK 待响应队列、全历史容量、Runtime 停用后证据分类以及 UI 陈旧回执/确定拒绝问题均已修复，相关公共回归完成红绿验证。

完整说明见 [文本轮次及取消](../../../../docs/sessions/turns.md)。本票不包含13队列管理、14事件传输、15权限响应、16结构化输入、17协商输入设置、23原生恢复、24 MCP 或25产物功能；真实 Claude/Codex、Linux 和远程验收保持在各自后续工单。浏览器断线不会停止 Run，时间线不充当原生 Agent 记忆。
