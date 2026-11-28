# 08: 「文件」面板头部收敛（搜索框常驻，头部只留 重新读取 与 ··· 菜单）

**What to build:** 沿 07 的文件页再走一步，头部参考 ZCode 的 `WorkspaceFileTree`（`packages/ui/src/workspace-file-tree/WorkspaceFileTree.tsx`）：搜索框从「按钮切换出的一条」改为常驻一行，置于标题行之上；38px 标题行只留 根路径 + 重新读取 + `···`（更多操作）两个控件，新建文件 / 上传文件 / 复制路径 收进 `···` 打开的根目录菜单（与 dsh 一致——两个参考的头部都没有创建按钮）。编辑器工具条不再折行：编辑中隐藏行数，`flex-wrap` 去掉。树、行菜单、键盘语义、服务端接口都不动。

**Blocked by:** 07: 「文件」面板按 dsh 文件页重做

**Status:** resolved

- [x] `plugins/workspace/src/file-navigator.tsx`：搜索行常驻（去掉 `searchOpen` 门控与头部搜索切换按钮）；头部删 新建文件 / 上传文件 按钮，加 `···` 按钮（`aria-label="更多操作"`、`aria-haspopup="menu"`、`aria-expanded` 跟随菜单开合），复用 `openMenu({ kind: 'root' }, …, { align: 'end' })` 打开现有 `FileMenu`；上传的 `<input type="file">` 移为视觉隐藏（`.fileInput`，保留 `aria-label="上传文件"`——`negotiated-input` 按 label 驱动它）；`along()` 里 ArrowUp 回搜索框不再看 `searchOpen`。
- [x] `plugins/workspace/src/file-store.ts`：`TreeState` 删 `searchOpen`。
- [x] `plugins/workspace/src/file-editor.tsx`：编辑中不渲染 `第 x–y 行 / 共 n 行`。
- [x] `plugins/workspace/src/files.module.css`：`.searchBar` 改为顶部一行（`margin: 8px 8px 0`）；删旧的 label 覆盖 input 规则，加 `.fileInput` 与 `.navigator { position: relative }`；`.editorTools` 去 `flex-wrap`。
- [x] 浏览器 spec：`workspace-files`（删两处 搜索文件 切换点击；重载后断言改为 搜索框存在且为空；两处 新建文件 改经 更多操作 菜单）。
- [x] 文档：`docs/workspace/files.md`（搜索框与头部两段）、`README.md`（「文件」面板一句）。

验证（2026-11-28，Node 24.22.3）：`pnpm typecheck` 通过；全量 `vitest` 46 文件 452 条通过；Playwright 全量 126 条通过（`workspace-files` 两条先行单独跑亦过）。另起真实 Host 目检截图（右栏窄宽两档）：搜索行常驻、标题行只剩 路径 + 重新读取 + `···`，窄栏无溢出。

## Comments

- 2026-11-28：三个取舍（问题未获回答，按推荐项定）：头部取 ZCode 形态（搜索常驻 + 单个 `···`）；标题行保持完整路径（dsh PathLabel 式，目录淡色、末段亮色）；新建 / 上传收进 `···` 菜单。与参考的偏离照旧：行尾 `···`（触屏）、150ms 防抖；`negotiated-input` 对 `上传文件` input 的直接驱动使隐藏 input 保留 `aria-label` 而非 `aria-hidden`。
