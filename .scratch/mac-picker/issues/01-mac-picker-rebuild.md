# 01: 撤销原生方案并重做 mac 风格选择器

**What to build:** 删除 osascript 原生选择资源，恢复 browse 资源；选择器组件按 macOS 窗口样式全量重写。

**Status:** resolved

- [x] 删 `pick.ts`/`workspace.pickDirectory`/`pickDirectorySchema`；恢复 `browse.ts`、browse 资源注册与契约（自 2f6279c）。
- [x] `directory-picker.tsx` 重写：标题栏红绿灯（红=取消）、返回/前进历史、搜索过滤、收藏栏图标、列表图标与蓝色选中、↑↓→← 键盘导航、底部路径栏与操作行；纯函数与 NSOpenPanel 语义（单击选中/双击进入/未选中=当前目录/文件行禁选/Esc 取消/截断提示）不变，`tests/directory-picker.test.ts` 不改全过。
- [x] `client.tsx` 表单回到「选择目录…」入口；确认后名称为空自动填 basename；submit 空目录守卫文案「请先选择工作区目录」。

验收：真实 Chromium 覆盖键盘/历史/搜索/路径栏/隐藏切换/前往文件夹/取消与红绿灯关闭（`tests/browser/workspaces.spec.ts`）。

## Comments

- 2026-11-22：实施完成；workspaces/workspace-files/sessions/session-reconnect 四个 spec 共 15 用例全过。`docs/workspace/workspaces.md`、README、GLOSSARY 同步改回自绘描述并保留 access 移除说明。
