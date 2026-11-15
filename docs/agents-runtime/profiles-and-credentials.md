# Agent Profile 与服务器凭据

`agent-profiles` 插件提供 `@aork/contracts/agent` 的 Provider 注册表、Profile 快照及服务器 Credential Broker，并通过 `aork.settings.sections@1` 提供 Agent 设置分组。默认没有内置真实 Provider；设置中的空状态不代表 Claude 或 Codex 已可用。测试只在临时发行组合中加入可控测试 Provider，不向默认组合加入模拟 Agent。

## Provider 与 Profile

一个 `aork.agent.providers@1` 服务维护多个动态 Provider 定义，Provider 插件声明依赖后调用 `register()` 并在自身生命周期结束时调用返回的 disposer。重复 Provider ID 被拒绝。Provider 定义包含服务器固定的 ACP stdio 启动描述、版本、参数校验器、认证方式及检测函数。浏览器只能提交 Provider ID、声明参数、版本要求、认证方式与凭据引用；任意 `command`、`launch` 或 `stateDirectory` 字段都被拒绝。启动描述不进入浏览器查询。

`agents.createProfile` 和 `agents.editProfile` 保存稳定 ID、递增修订及服务器生成的状态目录；编辑要求 `expectedRevision`，并发旧编辑被拒绝。状态目录按 Provider 与 Profile 隔离，不把一种 Provider 的 OAuth 文件交给另一种 Provider。`aork.agent.profiles@1.snapshot()` 返回独立、深冻结的值，包含 Provider 定义版本和凭据引用。后续 Session/Run 所有者须在启动前持久化此快照，并另外保存实际 adapter/二进制版本、插件图及运行身份；本票不创建 Run，也不声称 Profile 快照就是完整运行快照。

`agents.overview` 检测实际注册的 Provider，并显示二进制缺失、版本不匹配、Provider 缺失/检测失败、凭据不可用及状态目录故障。没有执行原生认证的 Profile 显示“尚需原生认证”，不因目录存在就声称已登录。两个真实 Provider 的版本适配和 OAuth 登录分别属于 20、21。

## 手动 API 凭据

先准备一个独立保存的 **32 字节二进制主密钥文件**，只能由运行 Host 的系统用户读取；不能是符号链接，权限不得向 group/other 开放。文件应在数据/备份目录之外独立管理。下面的示例使用 `wx`，拒绝覆盖已有密钥：

```sh
node -e "require('node:fs').writeFileSync('/absolute/private/aork-master.key',require('node:crypto').randomBytes(32),{mode:0o600,flag:'wx'})"
```

在私有 Distribution Profile 中为 `agent-profiles` 增加配置，然后在 Host 停止时通过公开 `profile apply` 应用，并重启：

```json
{"id":"agent-profiles","version":"0.1.0","enabled":true,"config":{"masterKeyFile":"/absolute/private/aork-master.key"}}
```

`ready` 仅表示服务器可在本地解密该引用，不证明远端 API 接受该凭据；Settings 将其显示为“本地可解密”，Profile 的“配置检查通过”也不表示已完成远端认证。

此配置仅在服务器激活时读取，不从 bootstrap、普通查询或 doctor/profile show 返回。新 API 凭据从 Settings 的密码输入框提交，成功后清空。已有秘密没有读取或预填接口。不要把秘密放进 Provider 参数或名称等公开元数据。

`agents.storeCredential` 在事务前以 AES-256-GCM 加密，使用独立随机 nonce，并认证凭据引用、Provider ID 与封装版本。数据库只保存密文和非秘密元数据。主密钥只留在服务器插件内存并在关闭时清零。`aork.agent.credentials@1.resolveApiKey()` 只给声明依赖的可信服务器消费者返回必要明文，禁止将其写入任何浏览器投影、日志或事件；同进程可信插件不是恶意代码沙箱。

缺失、错误长度、过宽权限或无法打开的主密钥文件使手动存储/解析以 `CREDENTIAL_KEY_UNAVAILABLE` 拒绝，Settings 显示缺钥；不丢弃秘密后假装成功。更换成不同的有效主密钥不会解密旧数据，旧引用显示 `unreadable`；恢复原密钥并重启可恢复读取。本票没有主密钥轮换或丢失恢复功能，不能用重新生成密钥代替恢复。

原生 OAuth 文件只承诺服务器生成目录的 owner-only 保护（0700），不声称 Aork 加密了 Agent 自己写入的文件。原生登录、受控子进程环境和实际认证注入属于后续 Provider/Run 工单。目录失去保护或被重定向后报告不可用。

## 公开命令与持久性

| 接口 | 行为 |
| --- | --- |
| `GET /api/queries/agents.overview` | Provider 检测、脱敏 Profile、凭据元数据和状态 |
| `agents.storeCredential` | 保存新手动凭据；结果仅含引用/名称/Provider/类型 |
| `agents.createProfile` | 校验并保存 Profile，创建专用状态目录 |
| `agents.editProfile` | 按预期修订编辑；已取得的快照与旧回执保持原值 |
| `GET /api/receipts/:commandId` | 返回已提交的不可变脱敏回执 |
| `GET /api/events` | 有序脱敏变更事件 |

三个变更命令复用 Host 的身份+commandId 去重和短同步事务：领域状态、结果、事件、回执同时提交。指纹是规范 wire JSON 的 SHA-256，不保存原始凭据载荷。相同内容重试返回原回执，内容变化冲突；启动 Token 或签名密钥轮换保留稳定主体及实体/回执身份。状态目录准备在事务外，失败或并发重复准备可能留下未引用目录，保留而不自动删除。

真实 Host/HTTP 测试覆盖实际 SQLite/WAL/数据文件中不存在已知测试明文、服务器 broker 可用、重启、缺钥/错钥恢复、Schema/参数/版本/凭据错误、原生目录保护、旧快照及回执。浏览器测试覆盖公开 Settings 的创建、编辑、刷新、重启与窄屏。所有验证均在本机 macOS，未部署远程服务；未执行真实 Claude/Codex 登录、ACP prompt、Session 或 Run。
