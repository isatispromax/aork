# 24: 让 Agent 调用选定的工作台工具

**What to build:** 用户选择工具集，Agent 经 MCP bridge 调用一个真实文件工具，看到结果或错误，运行结束后授权失效。

**Blocked by:** 12: 完成文本执行轮次并随时取消

**Status:** claimed

- [ ] 公开工具注册、会话工具集和 Run 快照可查询；先用真实 workspace 文件工具完成调用，不依赖整个 Artifact 模块。 工具、资源和指导配置分别建模，不承诺 Agent 原生 Skill 格式互通。
- [ ] 每 Run 独立 stdio bridge 通过受保护 Unix socket 使用短期令牌，令牌绑定真实运行和允许工具，Agent 自填 Session ID 不能授权。
- [ ] 工具调用尊重 Workspace Claim 和目录访问范围，返回按 MCP 格式校验，失败或无效返回明确报错。
- [ ] 新增或升级工具不静默加入已有运行；Run 停止、授权撤销或 bridge 失效时令牌失效。
- [ ] 登记异步工具句柄并支持取消；尚未确认写入停止时 Claim 仍 blocked，停止不能仅结束 adapter 而放任工具继续写入。
- [ ] 通过浏览器工具选择、公开调用记录、真实文件结果及 ACP 替身驱动 MCP 验证越权、撤销、失败和停止。

规格用户故事：44, 45, 46。

验收共识：遵循正式规格、领域词汇与已接受 ADR（含全界面公开替换契约 ADR-0004）；使用真实 Host、插件和持久化，经浏览器或公开命令/查询/事件及维护入口验证外部行为。ACP 协议替身仅用于外部 Agent 与故障控制，真实 Agent 验收不得被替代。

## Comments

- 2026-11-16：12 已完成，本票进入实施；先完成公开工具选择、真实 stdio bridge／Unix socket 与本机文件调用。接口计划见 `/tmp/aork-mcp-architecture-plan.md`，仅为实施参考。每次运行授权、实际调用者校验、工具任务停止证明与 Workspace Claim 保持是首要验收；不以本机或受控 Agent 结果替代真实 Provider／Linux 验收。

- 2026-11-15：用户确认 36 张工单的拆分及依赖关系，按已评审草稿发布；本票尚未开始实施。

- 2026-11-15：按用户“第一项先做界面交互原型，交互确认后再完成功能开发”的决定，本票由原 23 顺延为 24；原验收范围与历史记录保留，原依赖按同一映射顺延。新 01“界面交互原型与用户确认”是本票的传递前置，用户确认交互前不得开始本票功能开发。

- 2026-11-16：实施候选已在 `codex/aork-24` 完成，仍保持 `claimed` 待主协调者独立审查及接受。公开契约、边界、打包、版本与验证范围见 `docs/tools/scoped-mcp.md`；交接见 `/tmp/aork-ticket-24-handoff.md`。Node 24.22.3 的整套 Host 测试 19 文件／210 用例通过；最终 Tools／安装器定向 32 用例及浏览器 2 用例通过。已实测真实 ACP 替身启动实际绝对 bridge 描述符、MCP stdio／Unix socket、真实文件读写、当前 Claim 授权、公开调用记录、取消／撤销／失败、独立工具与 UI 包、真实 FileHandle IO 未结束时保留 job／Claim（含提供者未 await 文件 Promise）。这些不构成真实 Claude／Codex 或 Linux 验收。16／17 接口尚待主协调者接受后合入及联合复验；本条不关闭本票。

- 2026-11-16：根据独立安全审查的 S24-01／S24-02 修复候选：合入已接受 16（集成 tip `cca6301`，本分支合并 `4c7c85b`），新增 form Runtime mutator 的实际 Interactions 调用者门禁。公开测试先复现 pending／普通关闭／崩溃恢复的授权与事件缺口，再补齐 Tools 自有 cleanup scope 的短事务与事件、Runtime terminal fallback 同事务撤销；调用 unknown 只在真实 IO 与任务清理 join 后记录。安装器先复现注释分隔／optional／转义 require 漏检，移除 lexical prefilter，所有 JS 入口均做有界缓存的 Acorn 校验；public/private policy 不进入缓存。17 尚未接受，不取私有分支；本票仍为 claimed，需新的通用、TypeScript 与安全增量审查。

- 2026-11-16：通用审查 F24-01～05 的修复检查点：公开 TDD 证明异步 schema 编译前拒绝、每定义隔离 `$id` 校验缓存且 provider 重激活不串用；bridge 亦使用无状态隔离工厂，parser Promise 在 handler 前有界拒绝并消费 rejection；默认选择器可明确移除／替换／清空失效引用；真实旧版 Sessions 公共归档→升级回填保持只读且幂等；grant 用真实更新及 generation 排序，历史重复撤销不改当前 Run／重复发事件。仍待合入已接受 17 的联合边界验证与独立复核，本票不关闭。

- 2026-11-16：已合入接受的 17（`e7b5cc1`，本分支合并 `53a0036`），显式包装配置修改的实际 Sessions 调用者，保留 16 的 Interactions 表单门禁和 17 的完整配置规范化／实际交付／队列／详情。联合公开预算用例覆盖 16,000 字节配置、8 个最大长度工具引用与 owner、131,072 字节私有 schema 和 7,985 字节附件元数据；Run／Turn 事件最大 23,049／24,385 字节，未提高 32KiB 限制；无关 Workspace 命令和已就绪兄弟 MCP Run 正常。真实旧版归档升级回归改用接受的 17 旧 Sessions 包（尚无 Tools participant），保留 migration4 校验。仍待冻结联合复验及新的 TS／通用／安全审查，不关闭工单。

- 2026-11-16：补充真实大结果边界修复：有效 64KiB 文本读取曾因完整正文进入 32KiB call event 而无法完成，观测为 running＋cancellationRequested（该用例无关写入仍 200，不主张全局 poisoning）。现事件仅有界元数据，terminal latch 防止晚取消覆盖已提交终态；列表显式 resultOmitted、保留最近 100 历史及仍执行身份，完整正文通过 owner-scoped `tools.call` resource／snapshot 单条读取，UI 按需只加载一条。四份各 524,288 字节结果完整保存（2MiB），列表 2,327 字节；105 次后续完成后仍保留窗口外执行中身份，并能读取旧完整正文。认证／参数／未知 ID 401／400／404，停止后成功状态保留，未增大预算。仍待新冻结联合复验及独立审查。

- 2026-11-16：附带保护公开调用元数据的不可变性：普通独立 provider 测试曾可通过修改收到的 run reference 改变已保存调用归属（不主张 Workspace authority 绕过）；现交给 handler 的是冻结副本，公开类型亦只读，调用及历史归属保持真实 Run。该用例已 RED→GREEN，仍待最终冻结复验／独立审查。

- 2026-11-16：作者候选已合入接受的18／22／23及primary22051e3依赖修复。Tools提供实际scoped ExecutionWriters participant：同准入事务捕获真实owner／version／coverage与持久效果屏障，仅真实handler＋所有已启动IO＋finally／transport join才提供停止证据；默认unknown，无legacy complete回填。显式空工具库存于效果前记stopped；旧epoch opened／unknown不因空内存或撤销而释放。联合真实MCP证明native load回放阶段拒绝写入、ordered ready后新grant可写、队列保持暂停与native binding不公开。停机／deadline后late completion／缺失participant等证明与最终固定pin复验见交接；仍claimed，等待新的通用／TS／静态安全审查，不关闭。
