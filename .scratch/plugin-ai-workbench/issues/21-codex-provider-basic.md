# 21: Codex 真实远程接入

**What to build:** 用户配置并登录 Codex Provider，在 Linux 服务器完成真实多轮文本、权限响应和取消。

**Blocked by:** 15: 一次性响应权限请求, 19: 在 Linux 上运行远程工作台

**Status:** claimed

**Implementation phase:** 按用户2026-11-15“先在本机mac测试通过”的既定实施顺序（同 20 的 Mac 阶段口径，本票正文允许与 Claude 接入并行），当前仅领取本机 Provider 实现／Mac basic 验收；上方 19 的原始 Linux／远程依赖及本票远程验收不删除，Linux／远程认证与远程真实多轮未通过前不将本票整体 resolved。

- [ ] 以独立 Provider 实现检测、固定启动参数、远程认证方式、状态目录和凭据引用，复用 ACP Runtime；不修改内核或会话主流程。
- [ ] 使用对应 Codex ACP adapter 和锁定版本，不假定 CLI 存在原生 ACP 开关；按实际远程认证方式处理回调或终端需求。
- [ ] 真实有效凭据下完成 initialize、创建会话、多轮文本、授权目录文件操作、工具状态、权限响应和取消，秘密不进入浏览器/事件/默认日志。
- [ ] 本票记录并展示 Codex 实际协商能力与限制，不复制 Claude 参数；模型/模式/附件交互复用能力输入工单，原生恢复复用恢复工单，由最终验收组合验证。
- [ ] 记录 Node、SDK、adapter、Agent、OS、Plugin 精确版本与证据；与 Claude 接入工单可以并行，后续综合验收单独完成。

规格用户故事：11, 13, 16, 71。

验收共识：遵循正式规格、领域词汇与已接受 ADR（含全界面公开替换契约 ADR-0004）；使用真实 Host、插件和持久化，经浏览器或公开命令/查询/事件及维护入口验证外部行为。ACP 协议替身仅用于外部 Agent 与故障控制，真实 Agent 验收不得被替代。

## Comments

- 2026-11-20：Mac-local 阶段实现与真实验证完成，本票保持 claimed（远程验收未做，见下）。分支 `codex/aork-21-mac`。
  - **实现（不改内核与会话主流程）**：新增独立插件 `plugins/provider-codex`，复用 20 的架构（固定启动描述＝锁定 Node24 绝对路径 + 锚定 adapter `dist/index.js`；`launchEnvironment` 装配计划；`--version` 检测；一次性内存型 spawn 授权；未配置工具链时休眠，绝不回退 PATH 或全局登录）。契约仅加法：`PROVIDER_LAUNCH_ENVIRONMENT_NAMES` 追加 `CODEX_HOME`/`OPENAI_API_KEY`（runner-local 白名单随之生效）。Codex 实际差异（未复制 Claude 参数）：检测严格匹配 `@agentclientprotocol/codex-acp <semver>` 完整身份输出（裸版本号判 provider-failed，防止误认其他工具）；adapter 为环境驱动（无需 Claude 那样的固定协议 env，固定值为空集）；`api-key` 计划注入 `OPENAI_API_KEY`（adapter 亦接受 `CODEX_API_KEY`，Profiles 只保留单一注入名并已记录）；`native-oauth` 计划＝`CODEX_HOME` 状态目录 + owner-only HOME 子目录；登录观察走 adapter `cli login status` 真实委托（exit 0=observed、exit 1+"Not logged in"=absent、其余 unknown，原始输出不出插件）。
  - **锁定工具链**（隔离目录 `/Users/yangdi/.aork-toolchains/codex-agent-acp/2.8.0/`，清单 `aork-toolchain.json`；先落 package.json 锚再安装，npm 无锚时上溯污染 home 目录的首次安装已用 `npm uninstall` 还原）：adapter `@agentclientprotocol/codex-acp@2.8.0`（前代 `@zed-industries/codex-acp` 已废弃并指向本包）、adapter 侧 ACP SDK 2.8.0、`@openai/codex` 0.170.0 + `@openai/codex-darwin-arm64` 0.170.0-darwin-arm64（native **codex-cli 0.170.0**）、zod 4.6.7、diff 9.0.0、open 11.0.4、cross-spawn 7.0.6、vscode-jsonrpc 9.0.3；Host Node 24.22.3（tarball SHA256 校验）/ pnpm 10.30.2 / macOS 27.2.0 / Host ACP SDK 2.7.0（wire protocol 1 协商通过）/ Plugins：provider-codex 0.1.0（默认组合不启用，profile-disabled）。Codex 真实认证方式（源码+实测确认）：`api-key`（读 env `CODEX_API_KEY`/`OPENAI_API_KEY`）与 `chat-gpt`（ChatGPT 登录态存于 `CODEX_HOME`，另有 chat-gpt-device-code/gateway 变体由 adapter 在认证请求中协商）。
  - **真实验证（本机真实 Host + 真实 adapter，仅公开命令/查询）**：`agents.overview` 实测检测 `codex available 2.8.0`；隔离 Profile 可用性如实显示 `native-authentication-required`（隔离 `CODEX_HOME` 实测 `cli login status` → "Not logged in"，exit 1）；真实 startRun 内真实 initialize 成功（protocolVersion 1），真实 `session/new` 确定性失败 `-32000 Authentication required`，Run 以有界理由 stopped（"native Session creation failed or was interrupted"，不泄漏原始 stderr）；实际协商能力已记录（因 Run 未达 ready，能力由真实 adapter 握手探针记录并如实标注于证据 `adapter.realHandshake` 步）：`loadSession:true`（与 Claude 的 false 不同）、promptCapabilities image:true/embeddedContext:true/audio 未提供、sessionCapabilities resume/list/close/delete/fork/title/additionalDirectories/systemPrompt、mcpCapabilities acp:true/http:true/sse:false、authMethods api-key+chat-gpt、agentInfo `@agentclientprotocol/codex-acp` 2.8.0 (title Codex)。证据：`/tmp/aork-codex-real/acceptance-evidence.json`。
  - **真实凭据边界（STOP 点：多轮文本、授权目录文件操作、工具状态、权限响应、取消未以真实凭据验收）**：Codex 的认证边界早于 Claude——未认证时 `session/new` 即确定性失败（Claude 为首条 prompt 失败），故本阶段真实 Run 停在会话创建前。补齐需 (a) 经 `agents.storeCredential` 存入有效 OpenAI API key 并使用 api-key Profile（本机环境无该键，未捏造），或 (b) 用户在隔离 `CODEX_HOME` 内人工完成 ChatGPT 登录（`node <adapter> login` 浏览器/设备码同意，人工步骤，不由代理代办）。全局 `~/.codex` 未使用、未读取、未复制。Mac basic 真实对话验收在此边界后补验；运行/权限/取消的协议行为已有 ACP 替身测试覆盖，不冒充真实 Agent 结果。
  - **检查**：`pnpm build`、`pnpm typecheck`、`node scripts/check-boundaries.mjs` 通过；新增 `tests/provider-codex.test.ts`（4：休眠／检测+API-key 端到端隔离环境与秘密不落盘／native OAuth 门控／缺失·外来·畸形·悬挂输出全部 fail-closed）通过；目标复跑 provider-claude 4/4、provider-launch-environment 6/6、run-lifecycle 15/15、agent-profiles 9/9（合计 38/38）。三文件并行运行时 4-fixture fail-closed 用例（本票与 20 的同型用例）出现与集成基线同型的负载超时，隔离复跑全绿；未削弱/跳过任何既有测试。

- 2026-11-20：领取本票，启动 Mac-local 阶段（2026-11-18 曾因用量限额中断，今日按原指示从头重开）。镜像 20 的架构：独立 `plugins/provider-codex`、锁定隔离工具链、认证环境装配计划、一次性内存型启动授权；不复制 Claude 参数/能力，仅记录 Codex 实际协商结果。远程/Linux 验收保留。

- 2026-11-15：用户确认 36 张工单的拆分及依赖关系，按已评审草稿发布；本票尚未开始实施。

- 2026-11-15：按用户“第一项先做界面交互原型，交互确认后再完成功能开发”的决定，本票由原 20 顺延为 21；原验收范围与历史记录保留，原依赖按同一映射顺延。新 01“界面交互原型与用户确认”是本票的传递前置，用户确认交互前不得开始本票功能开发。
