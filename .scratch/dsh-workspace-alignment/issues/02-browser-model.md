# 02: 浏览器模型（纯逻辑）

**What to build:** `plugins/workspace/src/workspace-nav.ts` 重写为 dsh 浏览器模型：`owningParent`（最长段边界前缀的已登记祖先）、`orderedWorkspaces`（`order` 优先，其后登记序）、`buildGroups`（按工作区 / 按工作区树：子分组在父分组自身会话之前，折叠只隐藏后代）、`siblingInsert`（把拖拽项插到同级锚点之前，并把同级子序列就地回填到完整序列，非同级位置不变）、`dropTarget`（从落点元素向上找第一个与拖拽项同级的分组）。

**Blocked by:** 无

**Status:** resolved

- [x] `tests/workspace-nav-tree.test.ts` 覆盖上述函数
