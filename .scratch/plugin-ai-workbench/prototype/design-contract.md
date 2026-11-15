# 设计参考与采用边界

目标：为个人远程 Aork 工作台改进可点击原型，供用户确认交互。当前所有执行仍是内存模拟。本轮证据日期：2026-11-15。

| 参考 | 证据与置信度 | Keep | Change / 不照搬 |
| --- | --- | --- | --- |
| dsh | observed：本地 HEAD 39163dd30f 的 ui-layout、ui-workspace、ui-conversation、ui-theme 源码；官方模型设置截图。未启动 dsh 实机界面。 | 280px 紧凑树、居中阅读列、一体输入卡、按需右面板、中性灰与分级圆角 | 换为 Aork 项目/工作区/外部 Agent 领域；不复制品牌和内部 Agent 架构 |
| [AionUi](https://github.com/iOfficeAI/AionUi) | observed：官方首页与文件预览图片；后者画面标有 v1.5.5，是历史设计参考 | 发起工作时选 Agent 与项目；对话旁预览文件 | 不加入 Teams、十余 Agent 图标和助手市场 |
| [OpenCode](https://dev.opencode.ai/desktop) | observed：官方 V2 宣传截图和产品文档，未运行软件；V1 Web 文档不作为当前默认界面 | 简洁输入、环境信息、对话与结果并排 | 不强制所有会话采用顶栏标签，不以代码 diff 取代通用产物 |
| [LibreChat](https://www.librechat.ai/docs/features/artifacts) | provided：官方 latest(dev) 文档与官方产物截图；描述的是文档状态，非本地稳定版验收 | 消息中给产物入口，侧栏预览/源码/版本/下载；[项目展开会话](https://www.librechat.ai/docs/features/projects) | 不复制模型平台管理系统；不引入在线代码执行作为原型能力 |
| [LobeHub](https://github.com/lobehub/lobehub) | observed：官方 Home/验收宣传配图；未登录；部分细节文档有迁移占位 | 优先呈现 Needs you，再看运行与完成；交付包含可检查结果 | 不搬团队、Tasks、IM、拟人化雇佣与自动合并 PR 流程 |
| [OpenHands Agent Canvas](https://docs.openhands.dev/openhands/usage/agent-canvas/conversations) | provided：当前官方交互文档；observed：官方自动化页面截图，不能当完整会话截图 | 长执行过程汇总为阶段，保留失败/阻塞，文件与产物可展开 | 不把自动化、Git 和团队工程设为通用首页前提 |

## 最终方向（本轮设计推断，待用户确认）

采用 dsh 的空间组织和视觉密度，结合 AionUi 的发起配置、LibreChat 的产物入口和 OpenCode 的克制输入。LobeHub/Agent Canvas 用于核对注意力与过程呈现，不引入额外产品对象。D 方案默认展示，旧 A/B/C 保留作为比较。

## 可核验来源

- dsh 布局：[columns.ts](/Users/yangdi/code/gh/deepseek-harness/packages/client/ui-layout/src/client/columns.ts:10)
- dsh 输入：[InputBar.module.css](/Users/yangdi/code/gh/deepseek-harness/packages/client/ui-conversation/src/client/skeleton/InputBar.module.css:54)
- dsh 视觉：[base.css](/Users/yangdi/code/gh/deepseek-harness/packages/client/ui-theme/src/styles/base.css:6)、[圆角规范](/Users/yangdi/code/gh/deepseek-harness/docs/ui-radius.md)
- AionUi：[入门指南](https://github.com/iOfficeAI/AionUi/wiki/Getting-Started)、[首页配图](https://raw.githubusercontent.com/iOfficeAI/AionUi/main/resources/homepage.png)、[历史文件预览配图](https://raw.githubusercontent.com/iOfficeAI/AionUi/main/resources/file_generation_preview.png)
- OpenCode：[新会话配图](https://dev.opencode.ai/media/heroes/desktop-landscape-light.1280.f074db99.webp)、[结果并排配图](https://dev.opencode.ai/media/features/focused/desktop-3.800.08da6df5.webp)
- LibreChat：[产物面板配图](https://www.librechat.ai/images/features/artifacts/panel-preview-light.png)、[导航文档](https://www.librechat.ai/docs/features/navigation)
- LobeHub：[Home 配图](https://hub-apac-1.lobeobjects.space/blog/assets/c4e5bac0c35f840d9476256996e93e49.webp)
- OpenHands：[官方仓库](https://github.com/OpenHands/OpenHands)、[自动化页配图](https://assets.openhands.dev/screenshot/automation-preview.png)

## 风险与未知

配图可能是宣传或历史版本，不证明真实交互；本轮不运行这些项目的 Agent，也不验证其服务能力。D 的侧栏密度、面板默认关闭和过程折叠属于针对 Aork 的设计推断，仍需用户评审。参考图只在对照页引用，不作为 Aork 产品界面素材。

## 质量门槛

- [x] 明确目标、证据、观察与推断，以及各参考的借鉴/调整边界。
- [x] 保留 Aork 领域和交互确认门禁。
- [ ] D 方案在桌面和窄屏可操作，原有关键流程不回退。
- [ ] 原型及参考对照页均可打开，官方图片不可用时仍能访问来源。
- [ ] 用户确认最终布局与交互。

## 专业设计技能应用

| 技能 | 本轮用途 | 落地 |
| --- | --- | --- |
| reference-design-contract | 依据、借鉴与不照搬边界 | 本合同、DESIGN.md、交接文档及对照页 |
| frontend-design | 工作台构图、密度与组件层级 | D 导航树、阅读列、输入卡、按需资源面板 |
| emil-design-eng | 高频交互、焦点与动画克制 | 折叠和切换即时响应，保留键盘焦点，减少装饰动画 |
| web-design-guidelines | 可访问性、表单、响应式检查 | 标签、IME 草稿、skip link、焦点圈定、对比度和长内容处理 |

platform-design 本地仅为索引，未执行其完整上游规则。以上检查不等于 WCAG 全量认证。

## 本轮改进记录

| Before | After | Why |
| --- | --- | --- |
| 项目和会话各占一栏 | D 合并为项目/工作区/会话树 | 减少常驻列，保留工作关系 |
| 默认常驻产物栏 | D 按需打开资料/产物 | 将阅读空间优先留给当前会话 |
| 工具过程一直展开 | 可展开的过程摘要，待处理卡仍显式显示 | 减少噪声，保留行动入口 |
| 小字采用过浅灰色 | 次要文本 #60646c，关键说明更深，辅助字号至少12px | 计算对比度与实际可读性优先 |
| 侧栏收起/面板覆盖后焦点不明确 | 恢复到开关、浮层圈定键盘焦点和背景 inert | 减少键盘死路与误操作 |

首屏已在浏览器查看；末尾修复时浏览器控制工具不可用，改后交互尚需复查。图片参考页使用官方远程图源，无法保证离线可显示，始终保留原图/来源链接。

## 最新反馈：会话＋文件＋Git（2026-11-15）

用户明确要求精简：当前原型移除资料/产物界面、界面定制、插件独立导航、个人工作台配置；插件配置归入设置。右侧改为文件和Git改动，以上最新决定取代前文涉及这些入口的组合建议。

| 新本地参考 | 观察 | 采用边界 |
| --- | --- | --- |
| [codex README](/Users/yangdi/code/multai/codex/README.md:1) | 当前目录是CLI/TUI，不是桌面GUI源码；输入/状态在底部，diff有逐文件增删和行号 | 借鉴交互层级，不声称复制桌面UI |
| [Codex composer](/Users/yangdi/code/multai/codex/codex-rs/tui/src/bottom_pane/chat_composer.rs:17) | 输入区、附件与就近运行状态 | 保持聊天主线与明确的执行/队列状态 |
| [ZCode侧面板](/Users/yangdi/code/multai/ZCode/packages/ui/src/app-shell/sidePaneLayout.ts:1) | 按需展开，初始45%，聊天最小360px；移动端overlay | 右侧Files/Git tab可收起、加宽，保留选择 |
| [ZCode文件面板](/Users/yangdi/code/multai/ZCode/packages/ui/src/WorkspaceFileTree.tsx:43) | 树与预览内分栏，窄时择一显示 | 目录/搜索/预览/返回树，workspace隔离 |
| [ZCode Review](/Users/yangdi/code/multai/ZCode/packages/ui/src/GitPane.tsx:450) | 未暂存/已暂存/分支/上一轮来源与逐文件diff | 不混成提交历史，不增加真实提交操作 |

这是读取本地源码得到的证据，未启动codex/ZCode后端。底层全UI插件契约保留，不等于默认界面必须展示界面定制入口。

## 用户截图与双主题（2026-11-15）

用户提供 Codex 桌面截图作为直接视觉依据，并明确“深色与浅色都要支持，重要的是参考布局”。采用项目会话侧栏、连续中央阅读流、底部输入和右侧工作面板，不复制个人项目/账号内容、系统窗口装饰或终端/新页面入口；未复制私人截图到项目。

中间区域继续吸收 dsh 的无头像助手、右对齐用户气泡、紧凑标题与低输入卡。当前一套布局支持 system/light/dark，主题选择归设置，没有独立界面定制或个人工作台页面。

实际浏览器验证：1440×940下两主题均为左栏280、中央740、右栏420、输入卡98、标题/视图44+32；系统偏好变化仅驱动 system 模式。390px面板可在目录与预览间切换，Escape返回触发按钮。所有文件/Git仍为内存示例。

## 顶部减法与底部配置（2026-11-15）

用户再次要求简化中间顶部，并明确“对话下面要显示权限与模型配置”。本轮去掉面包屑、重复对话tab、顶部原型/参考文字，保留单行会话标题及面板/更多图标。权限在输入卡左下，Agent/模型在右下；状态与占用在卡外。只改变当前会话的示例配置，不自动响应已有权限请求。窄屏允许配置行自然换行。
