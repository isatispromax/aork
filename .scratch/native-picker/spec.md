# 换用系统原生目录选择器，移除访问权限概念

Status: resolved
日期：2026-11-22
范围：目录选择器替换（自绘 → 系统原生）+ Workspace access 概念移除

修订 `.scratch/workspace-first/spec.md` 的两个决定：其「浏览器原生 API 拿不到服务器绝对路径，只能自绘」的论证只覆盖浏览器侧——本机 Node server 直接调 `osascript choose folder` 即可弹出真正的 macOS 原生目录选择框并返回绝对路径。用户 2026-11-22 反馈：自绘选择器达不到要求（不是 Mac 的文件选择器），访问权限（只读/可读写 + 授权确认）没必要做。

## Problem Statement

workspace-first 交付的自绘 NSOpenPanel 风格目录浏览器交互与原生不一致，维护成本高（专用组件 + 服务端浏览资源 + 前端过滤/面包屑/前往文件夹逻辑）；新建工作区表单的访问权限选择与授权确认是多余的仪式。Aork 的主用法是本机 server（darwin），原生对话框经服务端触发即可获得；远程部署/非 macOS 时回退为手输路径（表单始终保留可编辑路径输入框）。

## Solution

1. **服务端原生选择资源** `workspace.pickDirectory`：darwin 上 `execFile('osascript', ['-e', 'POSIX path of (choose folder …)'])` 弹出系统目录选择框，返回 `{status:'chosen', directory}` 或 `{status:'canceled'}`；非 darwin / spawn 失败 → `WORKSPACE_PICKER_UNAVAILABLE` (503)，UI 显示提示并引导手输。同一时间只允许一个对话框（`WORKSPACE_PICKER_BUSY` 409）。execFile 10 分钟超时兜底孤儿对话框；传输层无 handler 超时、客户端 resource fetch 无 deadline，长挂合法（transport 对客户端断开的既有语义：服务端照跑完）。
2. **删除自绘选择器**：`directory-picker.tsx`、`directory-picker.module.css`、`browse.ts`、`workspace.browseDirectory` 资源与契约全部移除——服务端不再暴露任意目录枚举面。
3. **移除 access**：契约（`workspaceSchema`/`workspaceInputSchema`/`editWorkspaceSchema`）、服务端校验（`WORKSPACE_READ_ONLY` 分支）、UI（访问权限 select、授权 checkbox、详情展示）全删；工作区一律可读写，`file-view` 可写仅看状态。持久化 record 为 JSON blob，无 SQL 迁移；旧记录 strict parse 拒启，沿用清库政策。
4. **新建对话框**：目录 = 文本输入框（手输即远程回退）+「选择…」按钮；选择成功回填路径且名称为空时自动填 basename。

## 明确不做

- 不做非 macOS 平台的原生选择器（回退手输）。
- 不恢复任何只读工作区语义；Run 写协调（Claim 体系）不变。
- 不做选择器内新建文件夹。
