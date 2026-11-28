# dsh 对齐：工作区与项目管理（目录树嵌套、拖拽排序、行菜单、移除登记、工作区选择器）

Status: resolved（2026-11-27）／部分被修订（2026-11-28，见 `.scratch/dsh-workspace-alignment/`）
日期：2026-11-27
范围：左栏工作区分区升级为 dsh 管理形态 + 会话浏览器小对齐 + 新建会话工作区选择器
参考：dsh（`~/code/gh/deepseek-harness` 的 ui-workspace：WorkspaceBrowser / tree.ts / WorkspaceDialogs / WorkspacePicker）
前置：`.scratch/dsh-workbench-parity/`（会话浏览器 04、文件页 07 已完成）

> **2026-11-28 修订**：本规格「保持两个分区、不合并为单一浏览器」的决定已被撤销，左栏改为 dsh 形态的单一工作区浏览器；工作区归档态（`status`、`workspace.archive`）与「归档工作区 / 显示归档」界面已整体移除；「移除登记」改名「删除工作区」，`workspace.edit` 改为查重的 `workspace.rename`，同一目录只登记一次。以 `.scratch/dsh-workspace-alignment/spec.md` 与 ADR-0006 为准。

## Problem Statement

1. **工作区分区没有管理能力**：`aork.workspace.navigation@1` 只渲染平铺按钮行（仅可选择），编辑/归档藏在中央详情页；没有树形嵌套、拖拽排序、行菜单、行内重命名、会话计数与行内新建会话。
2. **没有「移除登记」**：只有归档（保留登记、拒绝新会话/Run）。dsh 语义的删除是仅解除登记——目录与会话历史保留，会话在导航中归入「未分组」。
3. **工作区顺序不可变**：`workspace.overview` 只有插入序，无 order 字段、无 reorder 命令。
4. **新建会话的工作区选择是原生 `<select>`**：多工作区时无法搜索；dsh 是搜索式 picker（名称/路径匹配、同名后缀区分、Enter 首个）。
5. **会话浏览器小差距**：「显示更多」一次展开全部（dsh 是 +5 步进）；三个悬停按钮占位（dsh 收敛进 ··· 菜单，含复制会话 ID）。

## Decisions（2026-11-27，用户已确认）

- **保持两个分区**：工作区分区升级管理形态，会话分区（已是 dsh 形态）不动；不合并为单一浏览器。
- **新增 workspace.delete**：仅解除登记；目录与会话历史不动（session 记录内嵌 workspace 快照）；存在活跃 Run Claim 时拒绝；归档态允许删（清掉保留记录）。
- 纳入：目录树嵌套模式、工作区拖拽排序、工作区选择器、会话侧小对齐（···菜单 + +5 步进）。
- 已知偏离：选择器菜单不含「新建工作区…」入口（目录选择器属 workspace 插件，跨插件边界）；「未分组」组禁用拖拽（sessions.reorder 需有效工作区）；搜索不做模糊匹配（dsh 有 fuzzy，本轮只做子串/前缀）。

## Solution

| 区域 | 变更 |
| --- | --- |
| 契约 | `workspaceSchema` 增可选 `order`；新命令 `workspace.delete {id}`、`workspace.reorder {orderedIds}`；事件 `workspace.deleted` / `workspace.reordered` |
| 工作区导航 | 树/列表两种视图（段边界路径前缀 + 最长匹配定父）；折叠状态 localStorage `aork.workspace.nav.v1`；行 = 字形+名称+计数+悬停 ＋+ ···菜单（重命名/复制路径/归档/移除登记）；指针拖拽仅兄弟层级 → `workspace.reorder` |
| 会话浏览器 | workspaceId 不在 overview → 末尾「未分组」组（无 ＋、无拖拽）；行悬停收敛为 ··· 菜单（置顶/重命名/复制会话 ID/交接）；「显示更多」+5 步进（剩余 ≤5 一次展开） |
| 新建会话 | 工作区 `<select>` → 搜索式 picker 菜单（≥2 个 open 工作区出现搜索框；名称前缀>名称子串>路径子串；同名最短唯一路径段后缀；Enter 首个；Escape 关） |

## 验收边界

- 单元：前缀祖先/最长匹配/段边界排除/order 兜底排序；同名路径后缀。
- 浏览器：行菜单重命名与移除登记（确认框 → 列表消失 → 会话浏览器现「未分组」）；树模式嵌套与折叠持久；拖拽排序跨刷新持久；选择器搜索与 Enter；···菜单；+5 步进。
- 文档：`docs/workspace/workspaces.md`、`docs/workbench/navigation-and-reading.md`、`docs/sessions/history.md`。

## Out of Scope

- 工作区 fuzzy 搜索、选择器内新建工作区（跨插件）、工作区悬停卡片、会话行右键上下文菜单、树模式下的跨层级拖拽（放行到祖先）、工作区归档界面的再设计。
