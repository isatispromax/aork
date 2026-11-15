# 13: 后续输入排队与显式继续

**What to build:** 运行中输入进入可见队列，按顺序逐条执行；暂停后只有用户明确继续才会派发。

**Blocked by:** 12: 完成文本执行轮次并随时取消

**Status:** claimed

- [x] 将首条文本路径扩展为持久 queued Turn，列表明确区分排队、发起和运行，重复 commandId 不创建额外输入。
- [x] 并发提交仍保证一个 Session 同时最多一个 prompt；受理事务与调度事务分离，外部交付仍在事务外。
- [x] dispatchPaused 持久化，Host 重启时未完成和排队工作保持暂停；重新连接不能清除暂停标志。
- [x] 用户通过公开命令继续队列；delivery_unknown 不作为自动重试项，恢复最后输入需用户另作明确决策。
- [x] 通过公开接口并发提交、浏览器队列和 ACP 收到的轮次验证顺序、幂等、暂停及重启底线。

规格用户故事：18, 19, 20, 21, 38。

验收共识：遵循正式规格、领域词汇与已接受 ADR（含全界面公开替换契约 ADR-0004）；使用真实 Host、插件和持久化，经浏览器或公开命令/查询/事件及维护入口验证外部行为。ACP 协议替身仅用于外部 Agent 与故障控制，真实 Agent 验收不得被替代。

## Comments

- 2026-11-15：用户确认 36 张工单的拆分及依赖关系，按已评审草稿发布；本票尚未开始实施。

- 2026-11-15：按用户“第一项先做界面交互原型，交互确认后再完成功能开发”的决定，本票由原 12 顺延为 13；原验收范围与历史记录保留，原依赖按同一映射顺延。新 01“界面交互原型与用户确认”是本票的传递前置，用户确认交互前不得开始本票功能开发。


## Answer — 2026-11-16（实现与作者验证完成，待父级复核/合并）

运行中后续输入现在保存为独立 `queued` Turn、原文用户消息及不可变回执，按数据库受理序号排队。受理与派发分别提交；派发事务以 queued 状态 CAS 取得首项，同时保存 Runtime prompt intent 与 Sessions 自有浏览器事件，ACP I/O 仍在事务外。每个 Session 同时只有一个已派发/运行/取消中的 prompt。相同 commandId 保持原始回执，变更内容冲突。

公开 `sessions.removeQueuedTurn` 只移除未派发项并保留 removed 记录、原文及原始回执；已派发或竞争失败返回409。取消、错误、中断、交付不确定、结束 Run 及重启都保留暂停；浏览器重连不会继续。`sessions.continueQueue` 只接受当前 Host 持有的 ready Run，旧 Run 排队项转入新原生上下文须明确 `allowNewContext:true`。不重试 delivery_unknown 或已中断原输入。

默认公开 composer/messages/tools 契约显示有序队列、移除、暂停和继续，执行中仍可受理输入。IME、草稿/不确定发送 ID、同 Workspace Files 与无关 hash 参数保持。Sessions 提供同步 DB overview/timeline snapshot；异步 `sessions.environments` 观察真实目录变化，不把文件系统状态伪装成 DB 快照。依赖14已提交的通用 SDK/传输机制不代表14完整验收或闭票。

作者验证：真实 macOS Host、构建插件、SQLite、Runner、HTTP/events/snapshots 与实际外部 ACP 进程，未 mock Runner 或私有数据库。6 个新公开 Host 用例及1 个新 Chromium 用例覆盖排队顺序/并发/回执/移除/取消后继续/重启/不确定交付/原生上下文明确选择/自有事件/公开快照。全 Host179/179（首个冻结源 b781672）；修复目录观察回归后，冻结源88e0fe7全 Chromium37/37、最终定向 Host8/8通过。最终91adef0仅调整窄屏发送提示，typecheck/build及队列 Chromium通过。边界检查、diff检查通过。完整说明见 docs/sessions/turns.md 与 /tmp/aork-ticket-13-handoff.md。

状态保持 claimed；父级负责全差异独立 generic/TypeScript/security 复核、集成合并和关闭。未实现15权限响应、23原生恢复、MCP或远程部署；4317原型未改动。

### 独立复核修复 — 2026-11-16

独立 generic 全差异复核（`/tmp/aork-ticket13-code-review.md`）确认并通过公开路径复现两项问题：归档环境的 queued Session 在整批事务中抛409，导致无关 Session 无法派发；物理目录观察查询瞬时失败后，成功观察未清除自己的错误。已改为逐 Session 派发事务，预期409只暂停该 Session 并提交自己的 queueChanged；投影与物理观察分别保存错误，仅各自成功时清除。新增 Workspace/Project 归档隔离 Host 用例及浏览器瞬时观察错误恢复/独立 snapshot 错误保留用例，均先取得行为 RED 再修复。

崩溃测试的受控外部 peer 原先会因等待 release 的定时器遗留进程；这是测试清理缺口，生产的 unknown Run 不推断旧 PID 所有权。受控 fixture 现在具有独立 self-exit 文件门和逐实例退出记录，在 unknown/no-replay 断言后及 finally 中触发，并在删除目录前等待所有受控实例退出。既有遗留进程由父级核对处理。未修改生产 Runtime/Runner 的未知进程规则。

仅按父级明确授权携带14窄依赖补丁 `386254a3`（本支 `c99b537`）：root/transport package.json 与 lock 将 ws 固定为8.23.0。生产修复冻结于 `779d4d5`；queue Host8/8、Turn/Run/snapshot Host38/38、已有相关浏览器11/11及新增队列/错误恢复浏览器2/2通过，typecheck/build/boundaries/diff通过。最终源 SHA、测试修正和日志见 `/tmp/aork-ticket-13-handoff.md`。仍保持 claimed，待父级 fresh TypeScript/最终全差异复核与集成；无远程发布或15权限实现。
