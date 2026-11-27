# 05: 设置页（ZCode 形态全窗口层）

**What to build:** workbench 的 `aork.settings@1` 从小对话框改为 ZCode 形态全窗口设置层；插件贡献机制不变。

**Blocked by:** 无（可与 02-04 并行）

**Status:** claimed

- [ ] `Settings` 视图：fixed inset-0 层，`role="dialog" aria-modal`，后方布局 `inert`；Esc/返回关闭、焦点还原（复用 useDrawer 模式）。
- [ ] 左栏：返回 + 简单搜索（过滤/高亮导航）+ 分组导航（68px 图标栏 / 268px 全栏，<900px 收窄）：组「基础」=内置「外观」（主题 浅色/深色/跟随系统，分段胶囊）；组「扩展」=`listExtensions('aork.settings.sections@1')`。
- [ ] 右侧圆角面板 + 面包屑头 + `max-w-4xl` 内容列；`SettingsRow`（分隔线、左标签/描述、右控件）+ `SettingsGroupCard`；新增 `settings.module.css`。
- [ ] 三个设置插件 manifest 补 `label`/`icon`：agent-profiles「Agent 配置」、plugin-management「插件」、plugin-diagnostics「诊断」。
- [ ] 主题 provider light/dark 增补 `--aork-hover/--aork-selected/--aork-input` 等 token（additive）。
