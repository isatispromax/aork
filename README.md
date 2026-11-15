# Aork

Aork 是由插件组成的个人远程 AI 工作台。当前实现工单 02 的工程启动切片：真实 Host、默认插件、持久化 Distribution Profile、受保护 HTTP 入口与浏览器插件装配。

账号初始化和登录属于工单 03，目前不可使用；项目、Workspace、Session、Agent、文件和 Git 功能尚未实现。默认组合能启动，不表示已经支持独立插件安装、完整界面替换或真实 Agent 接入。

## 本地运行

使用 `.node-version` 指定的 **Node 24.22.3** 和 `package.json` 指定的 **pnpm 10.30.2**。依赖使用精确版本和提交的 lockfile。原生依赖 `better-sqlite3`、`fs-ext` 在 macOS 开发环境与 Linux 服务器需要相应的 C/C++ 编译工具；不要在不同 Node ABI 间复用已编译的 `node_modules`。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start --data-dir .aork/personal --port 6688
```

打开 [http://127.0.0.1:6688](http://127.0.0.1:6688)。页面从真实 Host 读取引导清单，由 `auth-single-user` 插件显示未初始化的登录入口；展开启动诊断可查看当前组合、精确插件版本、SDK 和图版本。此时受保护查询返回 `ACCOUNT_SETUP_REQUIRED`，不会进入工作台。

数据目录保存 SQLite 数据库、启动配置和精确 profile。首次启动从 `profiles/personal-server.json` 读取默认组合；后续启动读取数据库中的组合与绑定配置。显式 `--host`／`--port` 会在成功启动后保存。默认只绑定 `127.0.0.1`，此切片尚未提供正式 Linux 部署与 HTTPS 配置。

一个数据实例只允许一个 Host 或维护命令取得 OS `flock`。描述符在关闭数据库后释放；进程暂停不会释放锁，崩溃后由 OS 回收。锁文件保持原 inode，不使用超时抢占。数据仅支持本机文件系统；运行时不要删除或替换 `host.lock`。

## 本地维护

先停止 Host，再使用同一入口检查或修复 profile：

```sh
pnpm aork doctor --data-dir .aork/personal
pnpm aork profile show --data-dir .aork/personal
pnpm aork profile apply profiles/personal-server.json --data-dir .aork/personal
```

`doctor` 校验静态清单、SDK 兼容、依赖与显式 UI 提供者，不执行插件入口。`profile apply` 只选择当前构建内已经存在的插件，静态校验和必要提供者检查通过后才保存；不安装、下载或升级插件。维护命令使用与 Host 相同的数据锁，运行中的实例不能被绕过修改。`--distribution-dir <path>` 可显式指定构建产物目录。

## 验证

```sh
pnpm typecheck
pnpm check:boundaries
pnpm test
pnpm exec playwright install chromium
pnpm test:browser
```

`test` 与 `test:browser` 会先构建真实产物。Vitest 经过公开 HTTP 与本地维护入口，使用真实默认插件与 SQLite；进程锁回归会暂停实际 Host 31 秒，再验证第二实例被拒绝和崩溃后可重启。Playwright 启动实际构建，检查默认登录、390px 布局、缺少提供者的维护兜底、视图异常隔离和页面退出时的失败 disposer 处理。故障测试只在复制的真实插件产物中注入故障，不引入产品测试后门。

## 工程边界

| 位置 | 职责 |
| --- | --- |
| `apps/server` | 启动、装配、同锁的本地维护命令 |
| `apps/web` | 引导、共享模块加载和最小错误兜底 |
| `packages/sdk` | 0.1.x 的公开 server/client 契约和静态校验 |
| `packages/kernel` | 静态图、显式 UI 选择、私有 Cordis 作用域 |
| `packages/storage` | 唯一 SQLite 写连接、WAL、Drizzle、配置和插件作用域状态 |
| `packages/transport-http` | 固定命令／查询入口、服务端权限强制和内容哈希资产 |
| `packages/ui` | 公开视图组合、主题／图标契约、作用域和错误边界 |
| `plugins/auth-single-user` | 认证服务的关闭态、可替换登录入口 |
| `plugins/workbench` | 默认布局、公开 home 子视图、主题与图标提供者 |

内核和浏览器引导不导入业务实现；公开 SDK 不暴露 Cordis、Fastify 或数据库对象。所有正常视图位于插件中。profile 为每个独占 UI 契约明确选择 `pluginId:providerId`，缺失或不兼容选择进入可定位兜底；注册顺序不决定提供者。默认布局通过 `runtime.renderView('aork.workbench.home@1')` 组合子视图。

构建先单独产出 server/client ESM，再通过 Host 运行时装配。React、React DOM、公开 client SDK 和 UI runtime 来自同一次拆分构建，保证共享模块身份；客户端插件将它们设为外部依赖，通过初始 import map 加载。CSS Modules 加入插件命名空间，避免独立产物的类名冲突。产物 `dist/compatibility.json` 记录实际 Node、SDK、Cordis、共享入口和 lockfile 校验和。

当前 SDK 保持 0.x；尚未通过架构替换验收，不承诺长期稳定兼容。此切片尚无业务命令、命令回执／持久事件、WebSocket 事件流、独立安装器或运行中插件维护流程；这些能力随后续工单实现。可信同源插件不构成恶意代码沙箱。
