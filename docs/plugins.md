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

文件视图使用独立公开 `aork.workspace.files@1` 契约，默认项目浏览器经 `runtime.renderView` 组合它。独立提供者通过通用 `runtime.resource` 访问 workspace 所有的文件接口；替换界面不会改变目录或写入许可。参见[文件契约](workspace/files.md)。
