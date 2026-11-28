# 07: 「文件」面板按 dsh 文件页重做（惰性目录树 + 即时搜索 + 行菜单，阅读交给预览）

**What to build:** workspace 插件的 Files 视图（`aork.workspace.files@1`）改成 dsh `ui-sidebar-files` 的 files 页形态：惰性展开的目录树、边输入边出的全工作区搜索、根路径标题行、行菜单；点文件在「预览」tab 打开，文本编辑留在面板内的编辑器；树的状态按 tab 存在渲染之外。服务端只追加一处向后兼容的搜索参数，并让搜索不再进入版本控制目录与 `node_modules`。

**Blocked by:** 03: 右栏停靠化（Files 已是 `inspector-tabs` 的面板类型）

**Status:** resolved

- [x] `packages/contracts/src/workspace.ts`：`FileSearchOptions { includeHidden?: boolean }`，`WorkspaceFileService.search` 增可选第三参；缺省行为不变。
- [x] `plugins/workspace/src/files.ts`（`search`）：始终跳过 `.git .hg .svn .bzr .jj .sl` 与 `node_modules`；`includeHidden` 为 false 时不匹配、不下钻 `.` 开头的条目。列目录不受影响。
- [x] `plugins/workspace/src/server.ts`：`workspace.search` 增可选 `includeHidden: '1' | '0'`。
- [x] 纯逻辑 `file-tree.ts`（层级模型、目录优先 + 自然排序、隐藏过滤、结果剪枝、高亮区间、祖先序列）与单测 `tests/workspace-file-tree.test.ts`。
- [x] 模块级状态 `file-store.ts`：按 `tab.id|workspaceId` 键的树状态（已读层、展开、搜索、当前文件、编辑器草稿），`tab.signal` 中止时清除；「显示隐藏项」按工作区存 `aork.workspace.files.v1.<workspaceId>`。
- [x] 组件：`tree-view.tsx`（嵌套 `ul/li`，行带 `aria-expanded` / `aria-current` / `data-file-path`）、`file-menu.tsx`（照停靠包 tab 菜单的结构：portal、首项聚焦、捕获阶段 Escape 与外点关闭、焦点归还）、`file-editor.tsx`（原内嵌源码与编辑器原样抽出）、`file-navigator.tsx`（标题行、搜索栏、惰性加载、定位当前文件、键盘、行菜单、上传 / 新建 / 下载 / 复制路径）；`file-view.tsx` 收薄为装配。
- [x] `files.module.css` 重写（38px 标题行、28px 控件、行按 dsh 尺寸、编辑器两栏与窄屏切换）；`workspace.module.css` 的 `.filesSection` 改为 flex 列，让视图由区域决定高度（旧实现靠写死 `100dvh`）。
- [x] `plugins/workspace/package.json` 加 `@aork/dock`（`DockGlyph`），锁文件随之更新。
- [x] 浏览器 spec：`workspace-files`（两条用例按树流程重写，含键盘、右键菜单、复制路径、隐藏项开关）；`preview-panel`、`workbench`、`right-region`、`sessions`、`scoped-mcp-tools` 中「正文显示在工作区文件区域」的断言改为「行带 `aria-current`」或「预览区域有正文」。`negotiated-input` 未改（`上传文件` / `文件已上传` 原样保留）。
- [x] 文档：`docs/workspace/files.md`（界面描述、搜索规则、新增「Files view」一节）、`docs/workbench/navigation-and-reading.md`、`README.md`、`docs/plugins.md`。

验证（2026-11-27，Node 24.22.3）：`pnpm typecheck`、`pnpm check:boundaries` 通过；全量 `vitest` 44 文件 443 条通过；Playwright 全量 120 条跑了三轮——第一轮 120 通过；自查修正后第二轮 119 通过，唯一失败是 `auth.spec.ts` 收尾处 `about:blank` 导航与错误页导航的竞态（用例正文断言均已通过，与文件视图无关，单独重跑 8/8 通过）；涉及的八个 spec（`workspace-files`、`preview-panel`、`workbench`、`right-region`、`sessions`、`scoped-mcp-tools`、`negotiated-input`、`terminal-panel`）另跑一轮 44 条全部通过。另有一次 `scoped-mcp-tools` 第二条用例在并行时偶发超时（它有一处 1.5 秒的紧断言），单独与全量重跑均通过。

## Comments

- 2026-11-27：三个取舍（问题未获回答，按推荐项定）：范围取 dsh 的 files 页，预览分栏旁的导航树留作后续；文本编辑留在「文件」面板；不加 dsh 也没有的 新建目录 / 重命名 / 删除。与 dsh 的两处有意偏离：搜索输入后 150ms 才发出（服务端是目录遍历而非 ripgrep）；行尾加了 `···` 按钮打开行菜单（触屏没有右键）。
- 2026-11-27：目检截图发现并修掉的问题——文件视图没有撑满面板（`FilesSection` 包装元素是普通块级元素，旧实现靠写死 `100dvh` 绕过）；编辑器换文件时上一个文件的保存错误还挂着；编辑态文本域与只读源码无法区分；浏览器原生搜索清除按钮与「清空搜索」重复。自查又发现两处重复请求：保存过文件后、以及从空输入开始第一次输入时，搜索会被立刻发出一次再被防抖发出一次；现在「一次输入只发一次请求」有断言守着。
