# 02: 新建工作区对话框重做与 access 概念移除

**What to build:** 目录字段改为「文本输入框 + 选择… 按钮（原生选择器）」；移除 Workspace access 概念的全部界面与服务端痕迹。

**Blocked by:** 01: 服务端原生目录选择资源

**Status:** superseded（access 移除部分仍生效）

- [x] create 表单：删「访问权限」select 与「授权此目录及其子目录」checkbox；目录 = 可编辑输入框 +「选择…」调 `workspace.pickDirectory`；picking 中按钮禁用；UNAVAILABLE 在目录字段下方 hint；chosen 回填且名称为空时自动填 basename；canceled 无动作。
- [x] edit 表单与 `editWorkspaceSchema` 只剩 `{id, name}`；详情页删「授权范围」「访问权限」展示。
- [x] `file-view` 可写 = `status === 'open'`；`files.ts`/`server.ts` 删全部 access 分支与 `WORKSPACE_READ_ONLY`；sessions `rejectedSendCodes` 去该码。
- [x] 删除 `directory-picker.tsx`、`directory-picker.module.css`。
- [x] 持久化不动 SQL；旧 record strict parse 拒启 → README 清库说明补充。

## Comments

- 2026-11-22：实施完成。排障中顺带修复一个先期缺陷：`Browser` 组件 navigation/page 双实例各自持有 overview 状态，创建后内容区要等 5s 订阅轮询才见到新工作区并闪「工作区不可用」——现于选中项缺失时立即补拉一次（`client.tsx` `missingFetch`）。该缺陷早于本特性存在，旧 browser 用例靠时序侥幸通过。

- 2026-11-22：部分撤销——access 概念移除与双实例 overview 修复保留；目录字段改回选择器入口（不再手输 + 原生按钮）。原生资源部分见 `.scratch/mac-picker`。
