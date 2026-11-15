# 03: 访问 Token 与浏览器会话

**What to build:** 参照 dsh，以服务器进程生成的随机启动 Token 链接进入工作台，换取受保护的浏览器会话；不提供用户名、密码或 Token 输入表单。保留 Aork 的当前浏览器退出与本地认证恢复能力。

**Blocked by:** 02: 默认插件启动与受保护入口

**Status:** resolved

- [x] 每个 Host 进程生成 32 字节随机启动 Token（base64url），仅在本地启动输出中提供 `/?token=…` 访问链接；不提供用户名、密码、账号初始化或 Token 输入表单。Token 不进入公共 bootstrap、诊断、错误或请求 URL 日志。
- [x] 仅精确根路径的 GET 接受启动 Token，常量时间比较成功后换取签名 HttpOnly、SameSite=Strict Cookie，并以 303 跳转到清除 Token 的 URL；生产使用 Secure，明文开发模式必须显式限制在 loopback。错误／缺失 Token 不授予业务访问，查询、命令和 WebSocket 不接受启动 Token 绕过入口。
- [x] 独立签名密钥和稳定的单实例主体持久化，浏览器会话默认 30 天；重启轮换启动 Token，但未过期有效 Cookie 可继续使用。Aork 另保留持久的每浏览器会话撤销，退出后刷新／重启仍不得访问，容量边界不得破坏已有有效会话。
- [x] HTTP 命令和查询由宿主强制授权，状态变更校验 CSRF，WebSocket 以 Cookie 认证并校验 Origin／来源；保留限流与拒绝访问行为。Token 交换也遵守适用的来源边界，不照搬 dsh 的中间件顺序削弱现有校验。
- [x] 认证插件故障时保持拒绝访问，同锁的本地访问恢复／签名密钥轮换可修复配置并撤销旧浏览器授权；公网不存在匿名管理、密钥恢复或 Token 读取入口。签名密钥与 Agent 凭据不回传浏览器。
- [x] 未授权提示页和退出控件使用公开认证 UI 契约，profile 可选择不同提供者；提示使用终端访问链接，不增加账号或 Token 表单。UI 替换不改变服务端会话、CSRF、Origin 或授权规则；认证失效后清除受保护缓存并撤销订阅。仅认证 UI 故障不撤销其他有效浏览器或停止 Run。
- [x] 通过真实 Host／持久化、本地启动输出、Token 链接及浏览器验证正确／错误 Token、URL 清理、重启、退出、非法来源、认证故障与 UI 替换。延迟 bootstrap／状态／退出响应不得覆盖新授权 Cookie；不以旧用户名／密码检查作为本票通过证据。

规格用户故事：1, 66, 67, 75, 78。

验收共识：遵循正式规格、领域词汇与已接受 ADR（含全界面公开替换契约 ADR-0004）；使用真实 Host、插件和持久化，经浏览器或公开命令/查询/事件及维护入口验证外部行为。ACP 协议替身仅用于外部 Agent 与故障控制，真实 Agent 验收不得被替代。

## Comments

- 2026-11-15：用户明确更正“不要使用用户名和密码，和dsh一样，使用token控制访问”。此前账号／密码实现尚未合入，不作为本票交付；按 dsh 当前源码的进程级 Token 链接换签名 Cookie、303 清理 URL 流程重做。Aork 既有每浏览器退出、持久撤销、本地恢复及缓存／订阅失效验收保留；这些是 Aork 需求，不冒称 dsh 已有注销／恢复接口。当前仍 claimed，依赖及编号不变。

- 2026-11-15：用户确认 36 张工单的拆分及依赖关系，按已评审草稿发布；本票尚未开始实施。

- 2026-11-15：按用户“第一项先做界面交互原型，交互确认后再完成功能开发”的决定，本票由原 02 顺延为 03；原验收范围与历史记录保留，原依赖按同一映射顺延。新 01“界面交互原型与用户确认”是本票的传递前置，用户确认交互前不得开始本票功能开发。
- 2026-11-15：登录属于可替换正常 UI，新增公开认证界面契约和失效权限处理；最终独立 UI 包替换由 35 组合验收。尚未实施，原依赖不变。


## Answer

2026-11-15：按用户更正后的 Token 规格完成本票，仅以最终 Token 实现和最终检查作为通过证据。未合入任何账号初始化、用户名／密码表单、scrypt 或密码登录命令。

实现边界：

- `auth-single-user` 生成每 Host 生命周期 32 字节随机 base64url 启动 Token；只由本地 `host.listening.accessUrl` 输出。精确根路径 GET 交换签名 Cookie 后 303 到 `./`；HEAD／POST／其他路径、错误／重复 Token 不授予权限。成功交换与全局安全错误响应使用 no-referrer/no-store；未知路由不回显请求 URL。已授权浏览器带旧链接只清理 URL，不重发 Cookie。
- 独立 32 字节签名密钥、稳定单实例主体、会话撤销与无效尝试限流保存在真实 SQLite 的插件作用域。HMAC-SHA256 签名覆盖随机会话 ID、规范来源与安全整数时间戳，校验 canonical base64url、签名、未来签发／过期和 30 天绝对寿命。来源摘要进入 Cookie 名，不同本机端口互不覆盖；重启轮换启动 Token，同一公共来源的有效 Cookie 继续生效。
- Cookie 为 HttpOnly、SameSite=Strict、Path=/，生产始终 Secure；显式 loopback 开发模式才省略 Secure。退出持久撤销当前浏览器会话，匿名状态／bootstrap 和退出响应均不写认证 Cookie，防止迟到响应覆盖新授权。160 会话满后拒绝新授权，保留已有有效会话；匿名访问不分配记录。错误链接有限流，正确随机能力链接和有效 Cookie 不受错误猜测配额阻断。
- Host 对业务查询／命令强制授权，只有认证提供者的 `auth.status` 可匿名查询。变更校验 CSRF 与规范 Origin；Token 交换另校验 Host、可选 Origin、跨站来源。WebSocket 只以 Cookie 和合法 Origin 进入握手，URL Token 不能绕过；合法授权升级暂返回 426，事件流由后续票实现。
- SDK 增加小范围、独立声明的 `maintenance` 入口及公开 scoped-state 维护契约。Host 在同一实例锁内分发 `access rotate`／`access recover`，不导入认证私有代码或密钥格式，不执行已坏的 server 激活入口；认证插件自行轮换密钥并撤销旧 Cookie。recover 还恢复发行组合的默认认证提供者／UI。修复过的产物按内容哈希重新加载，不复用同路径旧错误模块。
- 正常提示页和退出控件位于插件，分别使用 `aork.auth.login@1`／`aork.auth.controls@1`；profile 可选择替代渲染器，页面不含输入表单。runtime 在撤销或认证故障时清除受保护缓存、停止轮询订阅、取消／丢弃旧请求；身份与 CSRF 绑定变更推进代次，迟到的旧 401／503 不覆盖新授权。仅认证 UI 错误与服务授权故障分别处理。

实际验证（本机 macOS 27.2.1／26B131，arm64，Node 24.22.3 ABI 137）：

| 验证 | 最终结果 |
| --- | --- |
| `pnpm install --frozen-lockfile`、build、strict typecheck、SDK／框架边界检查 | 通过；精确依赖与平台信息写入 `dist/compatibility.json` |
| `pnpm test` | **19/19**；真实 Host、默认插件、SQLite、公开 HTTP 和本地维护，包含 Token 重启轮换／Cookie 保留、退出持久撤销、错误／重复／HEAD／POST、URL 错误脱敏、CSRF／Origin／WS、容量、限流、认证故障与独立维护恢复 |
| `pnpm test:browser` | **12/12**；Playwright 1.58.2／实际 Chromium，覆盖链接与 303 清理、无表单、HttpOnly、刷新／退出、390px、替代 UI、渲染故障、跨标签页缓存／订阅撤销、延迟 bootstrap／状态／退出和旧受保护请求拒绝 |
| 停止及锁 | 实际 Host 暂停 31 秒仍拒绝第二实例；进程退出可重启。另以真实 `100 Continue` 后未完成的 HTTP body 复现停止等待，修复后停止会断开连接并释放本地维护锁 |
| 独立复核 | 父代理 Chrome 157 正确／错误 Token、干净 URL、刷新／退出、无表单、空 `document.cookie`、无页面异常通过；截图 `/tmp/aork-ticket03-token-entry.png`。独立 TypeScript／所有权及安全源码复核无剩余阻塞项；HEAD、404 回显、限流及旧响应问题均有公开 red→green 回归 |

参考 dsh 当前源码提交 `39163dd30f703a79079e2d2446545cff3c453738` 的 `packages/host/authentication-token/src/{browser-auth,index}.ts`。本票不复制其 `/connect` API Peer 通道；持久的每浏览器退出及同锁本地恢复是 Aork 保留的额外要求。没有运行远程服务、Linux/systemd、HTTPS 代理或真实 Agent 验收；独立包安装和固定 Host 后的完整 UI 替换仍属于 04／35。本票解除 04、07 的直接前置，不代表后续业务已实现。
