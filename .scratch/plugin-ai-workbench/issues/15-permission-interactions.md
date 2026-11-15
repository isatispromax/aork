# 15: 一次性响应权限请求

**What to build:** 用户在会话中允许或拒绝有效权限请求，多标签页和取消竞争不会重复批准。

**Blocked by:** 12: 完成文本执行轮次并随时取消

**Status:** claimed

- [x] Interactions 持久化请求投影，从 Runtime 事实更新状态；提供会话卡片、查询和响应命令，不把活 RPC 句柄存成可跨连接复活的请求。
- [x] 原子领取响应后，Runtime 再核对 run、generation 和活句柄；两标签页仅一次成功。
- [x] 取消先封闭响应通道，旧连接、过时代次或断线请求不可再次提交；等待不会自动批准。
- [x] 本地写入成功仅显示已发送响应，进展事件才表示继续执行；发送窗口断线记录 delivery_unknown，不自动补发批准。
- [x] 经公开命令、两标签页和 ACP 故障验证响应、取消竞争、失效与未知交付，不依赖内部 CAS 函数断言。

- [x] 权限卡片与审批表单是公开可替换视图，展示服务端提供的来源、选项和有效状态；所选 UI 调用相同响应命令，无权自行授予权限、延长请求有效期或跳过单次领取／连接代次校验。

规格用户故事：25, 28, 29, 30, 31, 74。

验收共识：遵循正式规格、领域词汇与已接受 ADR（含全界面公开替换契约 ADR-0004）；使用真实 Host、插件和持久化，经浏览器或公开命令/查询/事件及维护入口验证外部行为。ACP 协议替身仅用于外部 Agent 与故障控制，真实 Agent 验收不得被替代。

## Comments

- 2026-11-15：用户确认 36 张工单的拆分及依赖关系，按已评审草稿发布；本票尚未开始实施。

- 2026-11-15：按用户“第一项先做界面交互原型，交互确认后再完成功能开发”的决定，本票由原 14 顺延为 15；原验收范围与历史记录保留，原依赖按同一映射顺延。新 01“界面交互原型与用户确认”是本票的传递前置，用户确认交互前不得开始本票功能开发。

- 2026-11-15：审批表单允许独立替换；公开服务仍负责真实响应有效性，35 验证替换前后同一 Interaction 的行为。尚未实施，原依赖及原型确认门禁不变。


## Answer — 2026-11-16（作者实施完成，待父级最终复核）

Interactions 从 Runtime 事实持久化权限请求及终态，提供授权 pending/history 查询、单项 detail、按 Session UUID 过滤的一致快照及 `interactions.respond` 版本1命令。快照只读取当前 principal 自有投影，32项视图优先保留 pending/responding 并明确 truncated；不读取其他领域私有表，也不把有效 Session 过滤器当作所有权证明。普通问句、未读与等待时间不会创建或批准请求。

响应仅接受 interactionId 与原请求提供的 optionId。无效选项及多余权限字段在领取前拒绝；pending→responding CAS、Runtime response intent、事件及不可变回执同事务提交。真实 ACP I/O 在事务外，Runtime 再核对选定 owner/principal、Run、Host epoch、generation、当前 Turn、原生 Session、带类型 request ID、活句柄及关闭／取消／维护门。不同命令在两浏览器竞争只有一个成功；原 commandId 精确重试只返回相同回执，改变内容冲突，不补发原生响应。

Runtime 在尝试前落库，SDK handler Promise 的 resolution 不作为已发送证明。私有协议流观察器在底层 writer.write 前再次校验、完成后才发布 responded；界面仅显示“已发送响应”。Agent 继续执行另由其进展事实证明。已有写队列阻塞时取消会把迟到的 selected 改为 native cancelled；进入发送窗口后断线保守记录 delivery_unknown，新的响应命令拒绝且不自动重发。协议取消、停止、旧连接／代次及 Host 重启使卡片失效。健康 Run 在处理权限与 Turn 期间仍持有 Workspace Claim，真实停止规则保持。

默认 Session Detail 经公开 `aork.interactions.cards@1` 组合权限视图；卡片再组合独立选择的 `aork.interactions.permission@1` 表单。原 Composer 的第二套权限轮询与“尚未提供权限响应”提示已移除，13 的队列、草稿、取消、显式继续及14的读取恢复／失败保护保留。卡片／表单均由公开快照和同一响应命令驱动；独立安装包在不改 Host 哈希的情况下替换两者。丢失已受理 HTTP 回执后继续使用原命令 ID；单独表单快照失败显示原因、保留内容并禁用新选择，恢复后不消耗或重复响应。

TDD／公开验收使用真实 macOS Host、构建插件、SQLite、Runner、HTTP／快照／事件、Chromium 和实际外部 ACP 进程；仅控制外部 Agent 行为／时序／故障及浏览器网络故障。10个权限 Host 用例涵盖修复后选项、竞争／回执、Claim、取消／协议 abort／旧 Host、堵塞写管道的未知交付与迟到批准封闭、超过32项历史仍保留有效卡片、多 Session／身份／UUID 过滤，以及 numeric0／string0／null 与200字符 Unicode option ID 精确身份。5个权限浏览器用例现均通过实际默认 Detail，覆盖两个实际 context 的命令屏障竞争、丢失回执重试、取消、390px、独立双契约替换和表单独立失败恢复；既有 Turn 浏览器兼容用例同步通过。

接受的13／14主线 `b1da360` 已合并于 `6cc7f1a`，通用存储／传输／客户端源码与已批准集成保持一致。实现冻结源 **f2c43b028161b63f9b4d772fea5c67910fe3f8e4**：实际 Node24.22.3、pnpm10.30.2；冻结安装、typecheck、build、boundaries、diff检查通过。稳定构建无并发重建，完整 **198/198 Host（18文件，73.23s）**、完整 **52/52 Chromium（47.9s）** 通过。日志 `/tmp/aork15-full-host.log`、`/tmp/aork15-full-browser.log`；默认桌面／390px与独立替换截图已查看。生产 Runtime／CAS／writer 与安全复核 pin df1f02f 字节不变。独立后端安全复核未确认源码问题；独立 generic/TypeScript/UI checkpoint 的唯一 MEDIUM 表单错误隐藏问题已用公开 RED→GREEN 在 b901400 修复。最终合并后界面、查询 delta 与修复仍交父级作 fresh generic／TypeScript／security 复核，本文不冒充最终获准。

状态刻意保持 claimed，父级负责最终评审、集成与关闭。完整说明见 `docs/interactions/permissions.md`、`docs/sessions/turns.md` 及 `/tmp/aork-ticket-15-handoff.md`。无 root 合并、push、部署或 worktree 归档；4317原型未动。未实现16结构化表单、17协商设置、原生恢复、MCP、全局分页待处理索引、Linux／远程或真实 Claude／Codex 验收；默认组合仍无伪造生产 AI Provider，Token→Cookie 访问方式保持。
