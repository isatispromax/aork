# 03: 左栏单一工作区浏览器

**What to build:** workspace 插件的 `aork.workspace.navigation@1` 重做为 dsh 单一浏览器外壳（工具栏：区头标签/展开式搜索/视图选项菜单/添加工作区；工作区分组与末尾「未分组」；dsh 工作区行与 SVG 线性图标；悬停卡；右键与 ··· 共用菜单；指针拖拽插入标记；重命名/删除对话框；空态；`aork.workspace.nav.v2` 持久化并裁剪）。sessions 插件新增 `aork.sessions.rows@1` 视图（分组会话行 / 单列表 / 搜索结果行，共享数据订阅），`aork.sessions.navigation@1` 退役。workbench 侧栏只挂一个分区。尺寸按 dsh：32px 行、2px 行距、4px 分组距、24px 热区、14px 图标、36px 工具栏。

**Blocked by:** 01, 02

**Status:** resolved

- [x] 外壳、会话行视图、workbench 组合
- [x] `tests/browser/workspaces.spec.ts`、`sessions.spec.ts`、`workbench.spec.ts` 等按新结构更新并补齐验收用例

实现备注：
- 外壳 `plugins/workspace/src/workspace-browser.tsx`（视图 `aork.workspace.navigation@1`），纯逻辑 `workspace-nav.ts`（泛型 `navTree<T>` 以携带完整记录），图标 `icons.tsx` 取自 dsh ui-primitives 线稿（MIT），悬停卡 `hover-card.tsx`。
- 会话行 `plugins/sessions/src/session-rows.tsx`（视图 `aork.sessions.rows@1`），上下文 `SessionRowsContext`（scope / orderBy / depth / onManualOrder / revealSessionId / onRevealed）；投影、待处理、未读、工作区列表在 `browser-data.ts` 里按 runtime 共享一份订阅——初版把 `subscribe` 写成每次渲染的新函数，React 反复重订阅导致快照留不住，已修。
- workbench 侧栏只挂一个分区；`canOpenInspector` 收窄为「仅在已有会话之上新建时隐藏右栏」，否则移除中央页面后只选工作区就永远打不开文件面板。
- 行的 `aria-label` 取名称本身，工作区行/会话行都可按精确名称定位；会话行按钮名为 `会话“X”的操作`。
