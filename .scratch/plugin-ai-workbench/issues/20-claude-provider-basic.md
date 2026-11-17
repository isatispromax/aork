# 20: Claude 真实远程接入

**What to build:** 用户配置并登录 Claude Provider，在 Linux 服务器完成真实多轮文本、权限响应和取消。

**Blocked by:** 15: 一次性响应权限请求, 19: 在 Linux 上运行远程工作台

**Status:** claimed

**Implementation phase:** 按用户2026-11-15“先在本机mac测试通过”的明确实施顺序，当前仅领取本机 Provider 实现／Mac basic 验收；15 已 resolved。上方19的原始 Linux／远程依赖及本票远程验收不删除，Linux／systemd／Caddy／远程认证未通过前不将本票整体 resolved。

- [ ] 以独立 Provider 实现检测、固定启动参数、远程认证方式、状态目录和凭据引用，复用 ACP Runtime；不修改内核或会话主流程。
- [ ] 使用对应 ACP adapter 和锁定版本，不假定 CLI 存在原生 ACP 开关；服务器与浏览器的 localhost 区别在认证流程中正确处理。
- [ ] 真实有效凭据下完成 initialize、创建会话、多轮文本、授权目录文件操作、工具状态、权限响应和取消，秘密不进入浏览器/事件/默认日志。
- [ ] 本票记录并展示实际协商能力与限制，不用协议声明替代运行结果；模型/模式/附件交互复用能力输入工单，原生恢复复用恢复工单，由最终验收组合验证。
- [ ] 记录 Node、SDK、adapter、Agent、OS、Plugin 精确版本与证据；MCP、完整恢复和升级后的综合验收由最终 Claude 工单完成，不能提前宣称首版全部兼容。

规格用户故事：11, 13, 16, 71。

验收共识：遵循正式规格、领域词汇与已接受 ADR（含全界面公开替换契约 ADR-0004）；使用真实 Host、插件和持久化，经浏览器或公开命令/查询/事件及维护入口验证外部行为。ACP 协议替身仅用于外部 Agent 与故障控制，真实 Agent 验收不得被替代。

## Comments

- 2026-11-18：Mac-local 阶段实现与真实验证完成，本票保持 claimed（远程验收未做，见下）。分支 `codex/aork-20-mac`。
  - **实现（不改内核与会话主流程）**：新增独立插件 `plugins/provider-claude`（固定启动描述＝锁定 Node24 绝对路径 + 锚定 adapter `dist/index.js` 绝对路径；`api-key`/`native-oauth` 两种认证的固定环境装配计划；`--version` 检测；`--cli auth status` 只读登录观察；未配置工具链时保持休眠，绝不回退 PATH 或全局登录）。契约加法（`packages/contracts/src/agent.ts`）：`providerLaunchEnvironmentPlanSchema`（仅名称与非秘密固定值）、`AgentProvider.launchEnvironment`、`observeNativeLogin`、快照 `environmentNames`、固定 Provider 环境名白名单（HOME/CLAUDE_CONFIG_DIR/CLAUDE_AGENT_ACP_PROTOCOL/ANTHROPIC_API_KEY/NO_BROWSER）、一次性内存型 spawn 授权 `aork.agent.launch-environment@1`（`bind` 在 acceptStart 绑定原始 prepared 快照，`consume` 在 spawn 前同步回调内由 Profiles 服务解密注入并即刻丢弃；外方 owner、伪造/复用凭据均被拒）。agent-profiles：`prepareLaunch` 按 Provider 计划放行 `api-key`/`native-oauth`（无计划保持 PROVIDER_LAUNCH_AUTH_UNSUPPORTED）、创建 owner-only HOME 子目录、overview 区分 `native-directory-only` 与 `native-login-metadata`（远端有效性仍以实际运行为准）。runtime-acp：acceptStart 取 grant、dispatch 要求已提交 pending op + 匹配 grant、ready 事实公布实际环境**名称**（不含值）、stop/shutdown 丢弃 grant、重启后无 grant 不派发。runner-local 白名单同步扩展并保留 NUL/尺寸检查。
  - **锁定工具链**（隔离目录，不入插件包，安装清单 `/Users/yangdi/.aork-toolchains/claude-agent-acp/0.107.0/aork-toolchain.json`）：adapter `@agentclientprotocol/claude-agent-acp@0.107.0`、adapter 侧 ACP SDK 2.6.0、Claude Agent SDK 0.3.323、bundled native CLI **2.1.323 (Claude Code)**（darwin-arm64 optional dep 实测解析）、zod 4.6.7、Host Node 24.22.3 / pnpm 10.30.2 / macOS 27.2.0 / Host ACP SDK 2.7.0（wire protocol 1）、Plugins：provider-claude 0.1.0 + 默认组合 0.1.0。全局 Claude 2.1.319 未使用、未读取、未复制。
  - **真实验证（本机真实 Host + 真实 adapter，仅公开命令/查询）**：`agents.overview` 实测检测 `claude available 0.107.0`；隔离状态 `--cli auth status` 实测 `loggedIn:false, authMethod:none`（此前会话所称“本机已登录”仅指全局状态，隔离 Profile 目录确实未登录）；真实 startRun 达到 `ready`：真实 initialize（protocolVersion 1）、真实原生会话创建（nativeBound）、真实协商能力已记录（prompt image:true/audio:false/embeddedContext:true；modes default/acceptEdits/plan/auto/bypassPermissions；模型 default/opus/sonnet/haiku/fable、effort、fast、ultracode；`agentVersion=0.107.0` 为 adapter 上报值，native 2.1.323 单独记录）；ready 后公开的环境**名称**为 CLAUDE_AGENT_ACP_PROTOCOL/CLAUDE_CONFIG_DIR/HOME/LANG/NO_BROWSER/PATH(+darwin __CF_USER_TEXT_ENCODING)。证据：`/tmp/aork-claude-real/acceptance-evidence.json`。
  - **真实凭据边界（STOP 点：多轮文本、授权目录文件操作、工具状态、权限响应、取消未以真实凭据验收）**：隔离状态第一条真实 prompt 确定性失败（`turn state=failed, reason "Agent returned a definitive prompt error (code -32000)."`），与隔离未登录一致。补齐需 (a) 经凭据接口存入有效 `ANTHROPIC_API_KEY`（本机环境无该键，未捏造），或 (b) 用户在隔离 `CLAUDE_CONFIG_DIR` 内人工完成 OAuth 登录（`--cli auth login`／`claude /login` 浏览器同意，属人工步骤，不由代理代办）。全局 Keychain/凭据文件按硬性规则不复制。Mac basic 真实对话验收在此边界后补验；运行/权限/取消的协议行为已有 ACP 替身测试覆盖，不冒充真实 Agent 结果。
  - **检查**：`pnpm build`、`pnpm typecheck`、`pnpm check:boundaries` 通过；新增 `tests/provider-claude.test.ts`（4）与 `tests/provider-launch-environment.test.ts`（6）全部通过，目标复跑（provider-claude/provider-launch-environment/run-lifecycle/agent-profiles）34/34 通过。全量套件在本机默认并行度下与干净集成基线同样出现负载型超时（基线 37 failed/263，本分支 37 failed/273），非本次回归；`--maxWorkers=2` 分批下全部 29 个文件均绿（主进程曾在尾部 OOM，属本机 16GB 资源限制，已分批复核补齐）。未削弱/跳过任何既有测试。

- 2026-11-16：启动 Mac-first 本机阶段。参考 `/tmp/aork-local-provider-integration-plan.md`、`/tmp/aork-local-provider-preflight.md`，仅本机 CLI 曾报告登录元数据，ACP适配器／隔离状态／真实对话尚未验收。先完成锁定工具链、独立 Provider 和内存型受权启动凭据接口，再按实际认证方式验收；不复制全局凭据、不把本机或替身通过计为远程完成。

- 2026-11-15：用户确认 36 张工单的拆分及依赖关系，按已评审草稿发布；本票尚未开始实施。

- 2026-11-15：按用户“第一项先做界面交互原型，交互确认后再完成功能开发”的决定，本票由原 19 顺延为 20；原验收范围与历史记录保留，原依赖按同一映射顺延。新 01“界面交互原型与用户确认”是本票的传递前置，用户确认交互前不得开始本票功能开发。
