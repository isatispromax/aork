# 03: 右栏停靠化（inspector-tabs 目标 + dock 外壳 + Files 迁移）

**What to build:** 右栏扩展目标改为面板类型注册表，默认 Inspector 变成停靠外壳。

**Blocked by:** 02: 停靠布局引擎 packages/dock

**Status:** claimed

- [ ] `packages/sdk/src/client.ts`：`UI_EXTENSION_TARGETS` 以 `aork.workbench.inspector-tabs@1` 替换 `aork.workbench.inspector-sections@1`；`packages/contracts/src/workbench.ts` 常量同步。
- [ ] `packages/sdk/src/index.ts`：extension schema 增可选 `multiple`。
- [ ] `plugins/workbench/src/client.tsx` `Inspector`：删除 panelHeader；顶部整条 tab 条（芯片 icon+label+×、"+"引导页、分屏、浮动、右端加宽/全屏/收起）；引导页列出 `listExtensions('aork.workbench.inspector-tabs@1')` 胶囊卡；单类型直接播种；分屏/浮动复用 packages/dock。
- [ ] 每会话持久化：localStorage `aork.inspector.v1.<sessionId>`（无会话用 `default`）；`inspectorOpen/inspectorWide` 与拖拽调宽（InspectorResize）保留；窄屏 <1150px 仍整宽抽屉。
- [ ] workspace 迁移：`aork.plugin.json` files-section 改 target 新目标（label「文件」icon「files」）；`FilesSection` 成为 tab body（`{panel, wide}` 上下文保留）。
- [ ] 独立 UI 夹具与浏览器测试更新（分区贡献夹具改 tabs 目标；整体替换 inspector 容器仍可行）。
