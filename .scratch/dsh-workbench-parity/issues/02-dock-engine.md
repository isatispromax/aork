# 02: 停靠布局引擎 packages/dock

**What to build:** host 无关的停靠布局引擎（纯逻辑）+ React 组件层，参照 dsh ui-dockkit。

**Blocked by:** 无

**Status:** claimed

- [ ] `packages/dock/src/engine.ts`：品牌化 `PaneId/SplitId/TabId`；归一化节点表（pane：`tabs[]/activeTab`；split：方向+children+sizes）+ `rootId` + `floats[]`（容量 1 的浮动 pane，无 tab 条）；`applyOp(state, op) → {state, inverse}` 捕获逆操作。
- [ ] ops：`openTab/closeTab/activateTab/moveTab/splitPane/closePane/resizeSplit/floatPane/dockPane/moveFloat/resizeFloat/closeFloat` + undo/redo 线性栈。
- [ ] `components/`：`DockSurface`、`PaneTree`（8px 隐形分隔拖拽条，指针捕获 + rAF 节流）、`TabLayout`（pane 内 tab 条、tab 拖拽跨 pane）、`FloatLayer`（可拖拽/缩放浮动窗）、共享 pointer 拖拽上下文。
- [ ] 单测：ops 与逆操作往返、undo/redo、拖拽语义。
- [ ] 包不依赖 `@aork/*` 业务包（可依赖 react 类型/peer）。
