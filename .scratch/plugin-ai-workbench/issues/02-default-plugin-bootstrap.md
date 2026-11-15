# 02: 默认插件启动与受保护入口

**What to build:** 从可复现的构建启动最小 Host，浏览器看到默认插件贡献的登录入口和启动诊断，未初始化时拒绝业务访问。

**Blocked by:** 01: 界面交互原型与用户确认

**Status:** resolved

- [x] 按既定技术基线锁定依赖，提供可重复构建、启动、类型检查与行为测试入口；本票不建立完整业务模块或安装器。
- [x] 默认认证与 workbench 通过最小 SDK 激活作用域注册服务和视图，内核不导入业务实现，公开 SDK 不暴露 Cordis、Fastify 或数据库内部对象。 SDK 初期保持 0.x，架构验证门槛通过前不承诺长期稳定兼容。
- [x] 建立版本化 UI 契约注册与独占提供者选择原语；默认登录和主布局由 profile 显式选择的插件提供，组合布局通过公开子视图接口挂载。正常业务 UI 不进入 apps/web／kernel；本票建立机制，不提前实现后续会话等业务。
- [x] Shell 仅负责引导、加载、权限强制和最小启动／错误兜底；缺少提供者时显示具体故障与本地维护路径，不出现宿主硬编码的正常登录、设置或工作台。
- [x] Host 启动取得单实例锁，同一数据实例的第二个 Host 被拒绝；后续服务沿用这一入口，不能等到真实运行后才补防重复启动。
- [x] 保存并读取默认 profile 与启动配置，重启后使用相同版本组合；静态清单先校验再执行入口。
- [x] 浏览器加载真实 Host 提供的引导和诊断；缺少账号或认证能力时不开放业务接口，启动失败给出可定位错误。
- [x] 通过启动命令和浏览器验收；默认组合的启动成功不被称为已支持独立插件安装。

规格用户故事：55, 68, 69, 73, 75, 76, 77, 78。

验收共识：遵循正式规格、领域词汇与已接受 ADR（含全界面公开替换契约 ADR-0004）；使用真实 Host、插件和持久化，经浏览器或公开命令/查询/事件及维护入口验证外部行为。ACP 协议替身仅用于外部 Agent 与故障控制，真实 Agent 验收不得被替代。

## Comments

- 2026-11-15 后续认证更正：用户要求使用 dsh 风格 Token 控制访问，不再使用用户名／密码。下述启动切片的“账号尚未初始化”属于当时的关闭态占位；03 负责替换为 Token 访问入口和真实授权，原密码实现尚未合入，不作为02已实现功能。

- 2026-11-15：用户确认 36 张工单的拆分及依赖关系，按已评审草稿发布；本票尚未开始实施。

- 2026-11-15：按用户“第一项先做界面交互原型，交互确认后再完成功能开发”的决定，本票由原 01 顺延为 02；原验收范围与历史记录保留，原依赖按同一映射顺延。新 01“界面交互原型与用户确认”是本票的传递前置，用户确认交互前不得开始本票功能开发。
- 2026-11-15：补齐全界面替换的最小契约和 profile 装配原语、宿主兜底边界；遵循 ADR-0004。尚未实施，依赖及原型确认门禁不变。

- 2026-11-15：ticket 01 已在 6279557 记录用户确认；codex/aork-02 从该集成提交开始实施。本票已领取，只实现启动切片。按已确认浏览器、公开 HTTP 与本地维护边界执行 TDD，真实插件与 SQLite，不新增业务测试后门。

## Answer

2026-11-15：默认插件启动切片已在本机 macOS 完成验收。源码位于 `apps/`、`packages/`、`plugins/` 与 `profiles/personal-server.json`；运行和维护步骤见根目录 `README.md`。用户已明确先在本机 Mac 测试，不进行远程部署。

- 工程锁定 Node **24.22.3**、pnpm **10.30.2**、TypeScript **5.9.3**、Fastify **5.7.4**、React／React DOM **19.2.4**、Vite **7.3.1**、`@deepseek-ai/cordis` **4.1.0**、better-sqlite3 **12.6.2**、Drizzle **0.45.1**、Zod **4.3.6**。提交精确 `pnpm-lock.yaml`；原生 OS 锁使用 `fs-ext` **2.1.1**。构建产物 `dist/compatibility.json` 保存实际安装版本、Node ABI、平台、共享入口与 lockfile SHA-256。
- Host 先校验完整静态清单、包内规范路径、SDK 和服务依赖，再执行默认插件 server 入口。公开 SDK 为 **0.1.0**，不暴露 Cordis、Fastify 或数据库对象；服务、查询、命令和 disposer 归属私有 Cordis 激活作用域。部分激活失败时撤销已有贡献和返回的 disposer，公开诊断标识故障插件而不输出原异常载荷。
- Distribution Profile 显式选择登录、主布局、home 子视图、主题与图标提供者。默认布局通过公开 `runtime.renderView()` 组合 home；Shell 只有引导、加载和最小失败兜底。单次拆分构建的共享 React runtime 通过 import map 装配独立 client ESM，插件 CSS Modules 使用各自命名空间。缺少选择和 renderer 异常显示具体契约／提供者及同锁本地维护路径。
- 一个本机数据目录只有一个 OS-held `flock` 描述符和一个 SQLite 常规写连接。实际 Host 被 SIGSTOP **31 秒**后第二 Host 仍被拒绝；SIGKILL 后 OS 释放锁，新实例可启动。数据库启用 WAL、外键、5000ms busy timeout 与 FULL 同步。profile、精确插件版本和成功启动的绑定配置持久化，重启保留组合并生成新 hostEpoch。
- 浏览器从真实 Host `/api/bootstrap` 读取清单和诊断，实际加载默认插件；`auth.status` 返回 `setup_required`。受保护查询和命令返回 **503 ACCOUNT_SETUP_REQUIRED**；认证能力缺失／激活失败返回 **503 AUTH_UNAVAILABLE**，伪造 Cookie 不开放业务访问。server 入口不作为浏览器资产提供。`doctor`／`profile show`／`profile apply` 使用同一数据锁，静态预检失败不替换已保存 profile。

验证环境：**macOS 27.2.1（26B131），arm64；Node 24.22.3（ABI 137）**。命令在项目根目录、该 Node 的 PATH 下执行：

| 命令／验收 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过，精确 lockfile 无需更新 |
| `pnpm typecheck` | 通过，strict TypeScript |
| `pnpm check:boundaries` | 通过，SDK／内核／浏览器／插件边界 |
| `pnpm build` | 通过，真实 Host、引导、共享 runtime、默认 server/client ESM 与兼容性清单 |
| `pnpm test` | **10/10 通过**；真实 HTTP、本地维护、SQLite、持久化、静态拒绝、故障作用域释放、单实例与实际进程暂停／崩溃恢复 |
| `pnpm test:browser` | **4/4 通过**；Playwright 1.58.2／Chromium 145.0.7632.6，登录插件、390px 无横向溢出、缺少提供者、renderer 故障兜底及失败 disposer 的页面退出处理 |
| `pnpm aork doctor --data-dir /tmp/aork02-maintenance-final` | 通过，默认精确组合与空诊断；不执行插件入口 |
| 独立 Chrome 157 浏览器复核 | 登录入口、账号未初始化、禁用登录与两个插件诊断均可见；清空错误再重载后无页面异常；截图 `/tmp/aork-ticket02-bootstrap.png` |

TDD 已记录从失败到通过的切片：缺少 Host、启动配置未持久化、丢失返回 disposer、31 秒心跳过期误放第二 Host、非规范入口路径和公开异常载荷泄漏。浏览器回归另外捕获并修复 CJS React 共享入口和独立 CSS 类名冲突。

限制：本票仅完成工程启动与受保护入口。账号初始化／密码／登录／Cookie 属于 **03**；预构建独立包安装属于 **04**，兼容诊断与运行中维护在后续工单。当前无业务命令、durable 回执／事件、WebSocket 流、真实 Session／Agent 或完整全界面替换验收。workbench 主布局已提供公开子视图装配机制，真实认证后的工作流继续由 03 及后续工单验收。**没有 Linux、systemd、HTTPS、远程部署或真实 Agent 验收结果，不能以本机 Mac 结果替代。**

- 最终只读评审补充：页面退出时 `loaded.dispose()` 的 AggregateError 已通过真实浏览器故障注入重现（未处理的 `UI cleanup failed`），再修复为显式捕获并只输出固定诊断 `AORK_UI_CLEANUP_FAILED`，不记录插件异常载荷。新增公开 disposer 浏览器回归先失败后通过；随后完整 Playwright **4/4**、strict typecheck 与边界检查通过。
