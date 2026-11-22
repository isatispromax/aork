# Aork

Aork 是由插件组成的个人远程 AI 工作台。当前本地实现覆盖工单 02–15：真实 Host、独立插件、公开 UI 装配、dsh 风格的 Token 访问控制、持久化工作区（顶层组织单位，绑定服务器目录）、文件浏览编辑、Agent Profile 与加密手动凭据、Session 历史及归档。现已通过实际外部 ACP 测试进程完成 Run 的原子受理、初始化、原生会话创建、持久工作区占用和确认结束。已接通文本 Turn、持久化流式回答、工具报告、持久队列、一致快照与断线重连、权限请求单次响应及真实取消。权限响应完成本地写入只显示“已发送响应”，不表示 Agent 已应用批准。真实 Claude／Codex 接入与 Git 功能尚未实现；默认组合启动不代表完整产品或真实 Agent 接入已完成。

## 本机运行

使用 `.node-version` 指定的 **Node 24.22.3** 和 **pnpm 10.30.2**。依赖为精确版本和提交的 lockfile。原生依赖 `better-sqlite3`、`fs-ext` 需要相应 C/C++ 编译工具，不要跨 Node ABI 复用 `node_modules`。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start --data-dir .aork/personal --port 6688 --insecure-loopback
```

本地启动输出中的 `accessUrl` 是当前 Host 的访问链接。打开它，浏览器以 303 跳转到干净的工作台地址并保存 HttpOnly 会话。没有授权的浏览器只看到由所选认证 UI 提供者渲染的访问提示页，应重新打开终端链接；页面没有账号、密码或 Token 输入表单。

默认 Cookie 使用 Secure、HttpOnly、SameSite=Strict、Path=/。本机明文开发必须显式加 `--insecure-loopback`，只允许绑定 `127.0.0.1`／`::1`。启动配置会持久化；生产启动可显式加 `--no-insecure-loopback` 关闭开发模式，并通过 `--public-origin https://workbench.example` 固定 HTTPS 公共来源。Cookie 安全标志不依赖可伪造的转发请求头。本轮只在本机 macOS 验证，尚未部署或验收 Linux、HTTPS 代理与远程服务器。

数据目录保存 SQLite、绑定配置及精确 profile。首次启动读取 `profiles/personal-server.json`，之后使用数据库中的组合；显式 `--host`／`--port` 成功启动后会保存。一个数据实例只允许一个 Host 或维护命令取得 OS `flock`；进程暂停不会释放锁，崩溃后由 OS 回收。数据只支持本机文件系统，运行时不要删除或替换 `host.lock`。

独立预构建插件可在**首次 Host 启动之前**通过 `pnpm aork plugin install <archive> [--profile <file>] --data-dir <blank-directory>` 安装。安装只增加候选；显式初始 profile 才选择独立布局、扩展、主题与图标。已有数据库或其他历史状态一律拒绝，停止 Host 不能代替完整维护安装。[独立插件说明](docs/plugins.md) 包含作者构建、公开 CLI、Quiet Aork 示例与归档格式。

## Token 与浏览器授权

每个 Host 运行实例生成 32 字节随机、base64url 编码的启动 Token，只通过本地启动输出给维护者。它不进入公共 bootstrap、诊断、错误、请求 URL 日志、浏览器存储或 WebSocket URL。普通页面刷新保留当前 Token，重启生成新的启动 Token。仅精确根路径 `GET /?token=…` 接受它；比较采用常量时间，成功后只写签名 Cookie 并以 303 跳转到 `./`，同时设置 no-store 和 no-referrer。查询、命令和 WebSocket 不接受 URL Token 作为凭据。

签名密钥与稳定的单实例主体独立持久化。Cookie 包含经 HMAC-SHA256 签名的版本、随机会话 ID、规范来源和时间戳；验证 canonical base64url、签名、来源、签发时间、绝对 30 天有效期及持久会话撤销记录。Cookie 名带来源摘要，不同 localhost 端口不会互相覆盖。相同公共来源上的有效 Cookie 可跨 Host 重启使用；旧启动链接不因此继续有效。已授权浏览器打开过期／错误启动链接，只清理 URL，不重新发放授权。

Aork 保留每浏览器的持久退出：`auth.logout` 在服务端撤销当前会话，刷新／重启后仍拒绝访问。退出响应和匿名 bootstrap／状态响应均不写认证 Cookie，避免迟到响应覆盖之后的新授权；残留的已撤销 HttpOnly Cookie 没有访问权。最多保留 160 个有效浏览器会话，达到容量后拒绝发放新会话，已有会话继续有效；匿名访问不占用会话容量。无效 Token 尝试按实际连接地址每 15 分钟最多 5 次、全局最多 20 次，限流持久化。

Host 强制查询和命令授权，业务插件不能靠声明 `public` 绕过；只保留认证提供者的 `auth.status` 公开查询。命令校验规范 Origin 及会话绑定 CSRF。Token 交换另校验 Host、Origin（若存在）和跨站来源；不从请求 Host 或 X-Forwarded-* 推断允许来源。WebSocket 升级使用 Cookie 并先校验 Origin 和身份；本票尚无事件流，已授权合法升级返回 426。后续事件工单沿用该强制边界。

界面通过公开 `aork.auth.login@1`／`aork.auth.controls@1` 契约装配提示页和退出控件，profile 可选择其他提供者。公开 runtime 提供查询缓存及可撤销轮询订阅；认证失败，或每 5 秒／窗口聚焦检查发现撤销后，会丢弃在途受保护结果、清除缓存、停止订阅并重新显示所选访问提示。仅认证 UI 故障不会撤销其他有效浏览器；认证服务故障则保持拒绝业务访问。

## 工作区

授权后进入单层工作区列表。工作区是唯一的顶层组织单位，创建工作区登记服务器上一个已存在的绝对路径目录（要求服务器可读写）。目录通过应用内自绘的 macOS 风格目录选择器选取：窗口栏（红绿灯关闭即取消）、工具栏返回/前进与当前目录搜索过滤、收藏栏（主目录/桌面/文稿/下载）、「前往文件夹」路径输入（含 `~` 展开，⇧⌘G 聚焦）、默认隐藏 dotfiles 可切换；单击文件夹会向右展开下一列，左侧保留已浏览的层级。↑/↓ 移动选择，←/→ 在列之间移动，「选择」确认当前文件夹，Esc 取消。选择确认后名称为空时自动填目录名。页面展示真实路径（经别名登记时另示登记路径），URL 保留选择；归档保留目录及记录，“显示归档”可查看历史登记。详细公开命令、回执、事件与持久化边界见[工作区说明](docs/workspace/workspaces.md)。

**升级说明：本次 schema 变更不做数据迁移。** 升级到本版本必须先清空数据目录再重建（旧数据库会因迁移校验不一致拒绝启动）；此前的外部目录登记记录不会保留，需要保留的登记路径请自行备份，重建后通过目录选择器重新登记。本次同时移除了工作区的只读/可读写（access）字段，旧记录不做兼容读取。

工作区文件视图支持真实目录树、文件名搜索、按行文本预览、上传、下载、新建与基本编辑。文本最多 256 KiB，传输最多 8 MiB；越界、目录替换及过期编辑由服务端拒绝。HTML 只显示源码，下载强制附件。文件不自动登记为产物或归因于 Agent；真实 Run 持有的工作区占用已接入同一许可。公开资源接口和写入许可边界见[文件说明](docs/workspace/files.md)。

## Agent 配置与凭据

在「设置 → 插件管理」启用发行包中的 Agent Provider，然后在「设置 → Agent」创建 Profile。`agent-profiles` 管理 Provider 检测、Profile 校验、脱敏状态和使用独立主密钥加密的手动 API 凭据。主密钥、原生 OAuth 目录和公开接口见[Agent 配置说明](docs/agents-runtime/profiles-and-credentials.md)。

## 会话与历史

在工作区的会话导航选择真实 Profile，保存 Session 后可通过 URL、刷新和重启恢复同一身份。界面展示实际 Agent、工作目录和运行状态；归档保留历史和关联，目录缺失也不抹去记录。会话导航、创建、详情及输入、消息、工具状态均通过公开契约独立替换。启动回执仅表示受理；ready 仍持有目录写入权，确认进程组与登记任务停止后才释放。浏览器关闭不结束运行，重启后的不确定占用保持阻塞。公开接口和边界见[会话说明](docs/sessions/history.md)、[运行生命周期](docs/sessions/run-lifecycle.md)与[文本轮次及取消](docs/sessions/turns.md)。

## 本地维护

先停止 Host，再用同一个数据目录维护：

```sh
pnpm aork doctor --data-dir .aork/personal
pnpm aork profile show --data-dir .aork/personal
pnpm aork profile apply profiles/personal-server.json --data-dir .aork/personal
pnpm aork access rotate --data-dir .aork/personal
pnpm aork access recover --data-dir .aork/personal
```

`doctor` 静态校验清单、SDK、依赖／契约版本、配置、明确授权及 UI 主选择／回退，列出发行包与独立候选，不执行 server 插件。失败保留原 profile 与有效目录；上次被拒绝的候选也可在授权后的“设置 → 插件诊断”查看包名、原因和修复动作。诊断与 bootstrap 隐去私有配置值；配置源文件由维护者保管。`profile apply` 可修复配置、启停与 UI，也可显式首次选择已安装且无需 DDL 的精确候选；不安装或下载新归档。已选 ID 的版本历史永久保留，更换版本或缺失／冲突 schema 会拒绝并要求后续维护。“设置 → 插件管理”提供受保护的配置、启停、界面提供者及扩展排序／显隐。纯 UI 变化只要求刷新，不重启服务器服务。运行服务通过公共生命周期门禁持有明确 idle 的接单屏障，busy／unknown／权威失联均拒绝服务变更。工单 02 的旧 profile 需显式 apply 当前组合或执行 access recover，以纳入新增退出控件契约。

`access rotate` 轮换所选认证插件的签名密钥并撤销全部浏览器会话；稳定主体不变。`access rotate` 依据显式服务选择调用当前认证所有者。`access recover` 停用其他认证提供者，恢复当前发行组合默认认证服务绑定、认证 UI 及其回退。Host 只在持有同一实例锁时调用插件声明的独立 `maintenance` 入口，密钥／会话格式由认证插件所有；普通 server 激活已失败时仍可维护。坏掉的包本身需要本地修复，其他 profile 故障先用 doctor/profile apply 处理。维护不提供公网管理、密钥恢复或 Token 读取接口。重启后从新的本地输出取得访问链接。

Token 链接交换流程参考 dsh；每浏览器退出、持久撤销和同锁本地恢复是 Aork 另外保留的要求。没有复制 dsh 的 `/connect` API Peer 通道。

## 验证

```sh
pnpm typecheck
pnpm check:boundaries
pnpm test
pnpm exec playwright install chromium
pnpm test:browser
```

测试经过真实 Host、默认插件、SQLite 和公开 HTTP／本地维护入口。覆盖 Token 错误／重复／合法交换、303 清理、Cookie 属性与来源隔离、跨重启授权和退出撤销、CSRF／Origin／WebSocket 拒绝、限流、会话容量、认证故障与本地恢复。浏览器还检查替代认证 UI、跨标签页缓存／订阅撤销、延迟 bootstrap／状态／退出响应、390px 和可定位故障。每轮浏览器测试创建独立临时数据实例。故障只在复制的真实产物中引入，不增加产品测试后门。进程锁回归会暂停实际 Host 31 秒，再验证第二实例被拒绝及崩溃后可重启。

## 工程边界

| 位置 | 职责 |
| --- | --- |
| `apps/server` | 启动、装配、同锁本地维护分发 |
| `apps/web` | 引导、共享模块加载、访问强制及最小错误兜底 |
| `packages/sdk` | 0.1.x 公开 server/client/maintenance 契约与静态校验 |
| `packages/kernel` | 静态图、显式 UI 选择、私有 Cordis 作用域与独立维护入口加载 |
| `packages/storage` | 唯一 SQLite 写连接、WAL、Drizzle、配置及插件作用域状态 |
| `packages/transport-http` | 固定命令／查询／有界字节资源入口、来源与身份强制、内容哈希资产 |
| `packages/ui` | 公开视图组合、主题／图标、缓存／订阅、作用域和错误边界 |
| `plugins/auth-single-user` | 启动 Token、签名 Cookie、单实例主体、持久会话／限流、本地密钥维护、认证 UI |
| `packages/contracts` | 所属领域的公开版本化数据／语义服务契约 |
| `plugins/workspace` | Workspace schema、迁移、Drizzle 编译、目录校验与浏览、文件服务／写入协调、命令与可替换浏览界面 |
| `plugins/plugin-diagnostics` | 受保护的诊断查询、可替换诊断视图及设置扩展 |
| `plugins/sessions` | Session 身份、Run／Turn 投影、文本受理、流式消息／工具报告、取消及公开会话视图 |
| `plugins/runtime-acp` | ACP initialize／new／prompt／cancel、持久操作意图／事实、活响应通道、真实响应写入观察与有界协议流 |
| `plugins/interactions` | 权限请求投影、一次性响应领取、授权查询／快照及公开可替换卡片／审批表单 |
| `plugins/runner-local` | 受管 POSIX 进程组、受控环境及登记任务的停止确认 |
| `plugins/plugin-management` | 受保护配置／启停／界面组合及可替换管理视图 |
| `plugins/agent-profiles` | Provider 注册、Profile 与不可变值快照、加密手动凭据、Agent 设置分组 |
| `plugins/workbench` | 默认布局、公开 home 子视图、主题与图标 |

SDK 不暴露 Cordis、Fastify 或数据库对象，Host 不导入业务插件私有实现；正常视图全部由插件提供。React、React DOM、client SDK 和 UI runtime 使用同一次拆分构建与 import map，插件不捆绑第二份 React。CSS Modules 带插件命名空间；`dist/compatibility.json` 记录实际版本、Node ABI、OS 和 lockfile 校验和。

SDK 保持 0.x，未承诺长期稳定兼容。已实现 Workspace 业务命令、身份＋commandId 回执去重及事务内持久事件；已有实例安装／升级、运行中插件维护或完整界面替换验收尚未完成。可信同源插件不构成恶意代码沙箱。
