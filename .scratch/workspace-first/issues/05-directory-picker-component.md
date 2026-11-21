# 05: mac 式目录选择器组件

**What to build:** 应用内自绘的 macOS NSOpenPanel 风格目录浏览对话框，供新建工作区对话框调用（ticket 06）。

**Blocked by:** 04: 服务端目录浏览资源

**Status:** ready-for-agent

- [ ] 原生 `<dialog>` + `showModal()` 实现模态（仓库惯例），CSS Modules + `--aork-*` token，light/dark 均可用。
- [ ] NSOpenPanel 语义：单击选中行；双击/Enter 进入目录；底部「选择」主按钮确认；未选中任何行时「选择」= 当前浏览目录；文件行灰显不可选（选中文件时「选择」禁用）；Esc 关闭不产生选中。
- [ ] 列表渲染：目录优先 localeCompare 排序；symlink/other 标注 kind；>500 条截断时列表尾提示并建议用「前往文件夹」直达。
- [ ] 快捷入口栏：主目录 / 桌面 / 文稿 / 下载 四项静态入口；初始位置为用户主目录。
- [ ] 前往文件夹：路径输入接受绝对路径与 `~` 展开；目标不存在/不可读在位报错；这是默认隐藏 dotfiles 时进入隐藏目录（如 `~/.config`）的唯一途径。
- [ ] 隐藏文件切换：默认隐藏 dotfiles，一键切换显示；纯前端过滤，服务端数据不变。
- [ ] 面包屑 + 上一级导航；浏览错误（权限不足等）在位显示，对话框保持打开。

规格用户故事：2, 3, 4, 5。

验收共识：遵循正式规格与 ADR-0005；v1 不做新建文件夹按钮（grilling Q9 决定 defer）；经真实 Chromium 浏览器手测全部交互语义与错误路径。

## Comments

- 2026-11-21：grilling Q9 决定 v1 元素 = 快捷栏 + 前往文件夹 + 隐藏切换；Q4 决定照搬 NSOpenPanel 语义。与既有 modal 惯例（workspace/sessions/artifacts 三处 `<dialog>`）保持一致。
