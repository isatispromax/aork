# 独立插件的初始安装

工单 04 在本机 macOS 验证固定 Host 构建后另行交付的 server＋UI ESM 插件。安装器只接受**从未启动过 Host 的空白实例**。安装在第一次启动之前进行；任何 SQLite、认证／浏览器会话、业务／历史、迁移文件或未知状态都使安装失败。停止 Host 不能证明旧工具或进程已停止，不能用本安装器升级已有实例；完整维护安装、备份、迁移与回滚属于工单 34。

## 构建和选择

先完成固定 Host 构建，再单独构建示例。独立构建命令不写 `dist`，安装不修改 Host、默认包或 import map：

```sh
pnpm build
pnpm plugin:build --dir examples/quiet-workbench --out /tmp/quiet.aork-plugin
```

作者包包含 `aork.plugin.json`、`src/server.ts`、`src/client.tsx`，以及可选 `src/maintenance.ts`。manifest 的 server/client/maintenance 指向输出 ESM 文件，CSS 和其他公开资源必须列在 `assets`。默认作者构建会捆绑纯 JS 服务端依赖；运行时只允许 `node:` 内置模块。UI 只外置固定共享入口：`react`、`react/jsx-runtime`、`react/jsx-dev-runtime`、`react-dom`、`react-dom/client`、`@aork/sdk/client`、`@aork/ui`。不得捆绑另一份 React 或服务端持久化实现。示例使用公开 SDK、作用域状态和服务提供／查询／命令注册，没有引用 Host 私有组件。

只安装候选时，不改变启用组合和所选界面：

```sh
pnpm aork plugin install /tmp/quiet.aork-plugin --data-dir .aork/blank-candidates
```

要在第一次启动时使用它，先从当前发行组合生成显式 profile，保留其他插件及子视图选择：

```sh
node --input-type=module <<'JS'
import { readFile, writeFile } from 'node:fs/promises';
const profile = JSON.parse(await readFile('dist/profiles/personal-server.json', 'utf8'));
profile.plugins.push({ id: 'quiet-workbench', version: '0.1.0', enabled: true });
for (const [contract, provider] of [
  ['aork.workbench.layout@1', 'layout'],
  ['aork.ui.theme@1', 'theme'],
  ['aork.ui.icons@1', 'icons'],
]) profile.ui.providers[contract] = `quiet-workbench:${provider}`;
profile.ui.extensions = [
  { id: 'quiet-workbench:privacy', order: 10, hidden: false },
  { id: 'quiet-workbench:service', order: 20, hidden: false },
  { id: 'quiet-workbench:extra', order: 0, hidden: true },
];
await writeFile('/tmp/quiet-profile.json', JSON.stringify(profile, null, 2));
JS
pnpm aork plugin install /tmp/quiet.aork-plugin --profile /tmp/quiet-profile.json --data-dir .aork/blank-selected
pnpm start --data-dir .aork/blank-selected --port 6688 --insecure-loopback
```

使用终端输出的 Token 访问链接进入。Quiet Aork 是选中的整个主布局，仍通过 `runtime.renderView` 装配默认公开子视图和访问控制。左下设置中的工作台名称经独立服务保存，刷新和 Host 重启均可读取。它验证主布局替换及服务设置，不宣称工单 35 的完整界面契约矩阵已经完成。

安装之前不要运行会打开数据库的 `doctor`／`profile apply`。第一次启动后，`doctor` 会显示 distribution／installed 候选及启用情况；已有实例不能通过 `profile apply` 改变涉及独立包的组合。认证密钥维护仍使用工单 03 的同锁、私有 maintenance 入口。

## 归档与静态拒绝

`.aork-plugin` 是版本 1 的 UTF-8 JSON 归档，根对象为 `{ archiveVersion: 1, members: [...] }`。每个成员为 `{ path, type: "file", data, sha256 }`；data 为规范 base64，sha256 是原始字节的 SHA-256。只允许普通文件，最多 256 个成员、32 MiB 归档、24 MiB 解码内容；不接受链接、目录条目、重复／冲突路径、绝对路径或 `..` 路径。安装器先验证所有成员，再写入暂存目录，检查完整静态图后保存初始 profile。

所有文件都必须是 manifest、声明的入口或明确资产。拒绝不兼容 SDK、外部／私有／未声明导入、计算得到的动态导入、未解析 CommonJS 依赖、未知 native addon／原生二进制及另一份 React。server 和 maintenance 不进入公开资产；浏览器 ESM、CSS 和资源从当前包内容哈希路径同源加载。`.js` 和 `.mjs` 都使用 JavaScript MIME。CSS 的相对 URL／导入必须留在明确公开资产中，可将 JS、CSS 和图片放在不同包内目录。

这些约束是可验证的打包和组合规则；可信同源插件依然有页面权限，服务端插件依然是受信任代码，不能把它当作恶意代码沙箱。初始安装不运行任何插件入口，也不运行迁移。

## 公开扩展契约

manifest 的 `ui.providers` 声明独占视图候选；只有 profile 的 `ui.providers` 显式选择才能使用。manifest 另可声明 `ui.extensions: [{ id, target, order }]`。扩展 ID 在包内稳定，profile 使用 `plugin-id:extension-id` 设置 `order` 和 `hidden`。排序先按显式 order（未配置时使用声明值），再按完整稳定 ID；安装与注册先后顺序没有选择权。

SDK 0.1.0 发布 `aork.workbench.navigation@1`、`aork.workbench.header@1`、`aork.settings.sections@1` 扩展目标。作者通过 `context.registerExtension(id, Component)` 注册，通过 `runtime.renderExtensions(target)` 组合。默认工作台与示例使用同一契约；每项扩展有自己的错误边界。主题与语义图标同样由 profile 明确选择，其设置和扩展呈现偏好纳入图哈希。

bootstrap 返回 API、SDK、Host 代次、当前图哈希及内容哈希资产。命令携带当前图哈希；旧图请求得到 `RELOAD_REQUIRED`，处理器不会执行。安装新包不会自动刷新旧页面、自动选择新 UI 或接管已有运行环境。

## 兼容性、配置和明确授权（05）

清单和 profile 使用以下公开字段；旧 manifestVersion 1 包省略新增字段时保留单实例、无可选依赖及固定共享运行时的默认语义：

| 位置 | 字段 | 约束 |
| --- | --- | --- |
| manifest | `version` / `sdkRange` | 精确 SemVer / 可满足的 SDK 范围 |
| manifest | `dependencies: [{ id, range, optional? }]` | 必需包必须启用；可选包不存在可继续，存在时仍检查版本；必需与存在的可选边均检测环 |
| manifest | `requires`, `optionalRequires`, `provides` | 精确 `service.id@主版本`；必需服务缺失或只有其他主版本时拒绝；可选服务缺失不阻止启动；同契约同时为 server／UI 必需依赖时，必需语义优先 |
| manifest | `serviceModes: { "service.id@1": "multi-provider" }` | 省略为 singleton；同契约多个提供者须全部声明 multi-provider |
| profile | `services: { "service.id@1": "plugin-id" }` | 同契约多个启用提供者时必须明确选择，包括 Host 使用的认证服务；`context.service<T>(id)` 只返回该选择，不按注册顺序覆盖 |
| manifest | `configSchema` | Ajv 8.17.1 严格 draft-07 schema；只接受同步 schema，拒绝异步 `$async` validator；不加载远程引用、不转换数据、不注入默认值；配置省略时用 `{}` 验证 |
| profile 插件选择 | `config` | 仅服务端 `context.config` 可读取的 JSON 对象；输出给浏览器及诊断 CLI 的 profile 移除其值，原始配置须保存于维护者的 profile 文件 |
| manifest / profile 插件选择 | `capabilities` / `grants` | 声明申请不等于授权；每项申请必须被当前 Host 支持并显式出现在该插件 grants 中，未声明 grant 也拒绝 |
| manifest UI | `runtime: { react, sdk }` | 可选 SemVer 范围，须满足 Host 共享 React 19.2.4 / SDK 0.1.0 |
| manifest UI 提供者／扩展 | `requires`, `capabilities` | 检查公开服务契约及已声明且获准的能力；提供者契约、扩展目标与稳定 ID 先静态校验 |
| profile UI | `fallbacks: { "ui.contract@1": "plugin-id:provider-id" }` | 回退也须为已启用、精确兼容的明确选择；渲染、加载或注册失败只采用该回退，无可用回退则呈现局部错误 |

当前 Host 能力表为 `diagnostics.read`、`filesystem.read`、`filesystem.write`。文件能力供工作区文件服务实施，实际目录范围与写入占用检查仍由所属服务强制；能力清单不构成文件系统或进程沙箱。插件不能提供 Host 保留的 `aork.plugins.diagnostics@1` 服务来获得权限。

同一包的提供者／扩展 ID 不可重复，profile 扩展偏好不可指向未知或重复项。独占视图必须显式选择；安装多个候选不会触发切换。配置或权限失败发生在入口导入之前。独立作者构建拒绝 Host／其他插件私有实现、Fastify、Cordis、数据库驱动及 `node:sqlite`；公开 SDK 和 `@aork/contracts/*` 是跨所有权调用入口。纯 JS 查询构造不等于打开数据库连接。预构建产物仍受归档导入规则约束；源码检查无法证明被任意第三方打包器嵌入的所有代码来源，可信插件边界保持不变。

## 受保护的诊断界面

默认 `plugin-diagnostics` 通过 `aork.plugins.diagnostics@1` 公开服务读取只读图摘要，通过已认证 `plugins.diagnostics` query 返回结果。它提供可替换的同名 UI 契约与设置扩展；默认工作台的“设置”对话框组合 `aork.settings.sections@1`，没有增加插件独立导航或 Host 固定管理页面。未认证查询仍由 Host 拒绝。

被拒绝的初始安装或 profile apply 把一条安全报告保存在实例的 `plugin-preflight.json`，同时保留原 profile 和有效目录。报告包含包、版本、故障代码、契约原因与修复动作；`doctor` 及授权后的“设置 → 插件诊断”均显示它。报告不包含配置值、数据派生的配置键、解析失败的输入、异常 cause、启动 Token 或认证密钥。已有报告不使从未启动的实例失去初始安装资格，维护者可修正归档／profile 后重新安装；运行 doctor 会打开数据库，因此仍应在所有初始安装完成之后运行。

配置或包本身的修正通过本地维护文件和公开初始安装／profile apply 路径完成。这里没有实现运行中启停管理（06）、已有实例安装／升级（34）或全部业务界面的替换验收（35）。

`access rotate` 按当前显式授权服务选择派发，独立认证提供者的密钥维护不会误发给包顺序中的第一个插件。`access recover` 在不导入普通入口的情况下识别并停用其他认证服务提供者，恢复发行版默认服务绑定、登录／退出视图及其回退，再调用默认提供者的私有恢复入口；若剩余组合还有其他静态错误，则不保存新 profile。
