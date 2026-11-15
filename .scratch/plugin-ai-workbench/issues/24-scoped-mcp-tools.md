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
