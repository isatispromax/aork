# Aork 界面交互原型

当前版本聚焦 **会话、文件与 Git 改动**。仅使用内存中的示例数据，刷新或重置会恢复初始状态；不读取真实服务器目录，不运行真实 Agent 或 Git。

## 当前界面

- 左侧：项目/工作区/会话、新会话、待处理与设置。
- 中间：对话、权限/表单、输入、排队、停止与恢复。
- 右侧：文件树与带行号预览；Git 未暂存/已暂存/分支/上一轮改动、增删统计及折叠 diff。
- 设置：Agent 与插件配置集中在这里。

当前不提供资料库、产物管理、界面定制、插件独立页面或个人工作台/账号配置。正常界面可经插件实现/替换的底层架构要求仍保留，原型不证明正式插件运行时已经实现。

默认进入 Aork 代码项目和 Codex 会话。当前收敛为一套布局，旧 A/B/C URL 进入当前 D 布局；历史版本分别保存在 archive-v1 与 archive-v2。设置提供浅色、深色和跟随系统，主题不会重置会话、文件或 Git 来源。

## 打开方式

双击 index.html，或在仓库根目录运行：

```sh
python3 -m http.server 4317 --bind 127.0.0.1 --directory .scratch/plugin-ai-workbench/prototype
```

访问 http://127.0.0.1:4317/?variant=D 。浅色/深色可分别加 `&theme=light` 或 `&theme=dark`，默认跟随系统。底部保留原型状态演示、重置及参考入口。

## 参考依据

主要参考同级 ZCode 的 Files/Review 侧面板；codex 目录是CLI/TUI源码，仅借鉴输入、运行状态、会话筛选与diff信息层级，不称其为桌面GUI源码。dsh与网络产品的此前依据保留在 design-contract.md 和 references.html，最新方向以 DESIGN.md 为准。

先前使用 reference-design-contract、frontend-design、emil-design-eng、web-design-guidelines 完成设计与审查；本轮继续保持清晰对比度、中文输入法、键盘焦点和窄屏处理。

## 确认状态

用户尚未确认最终交互。工单01继续等待评审；原型不会直接晋升为正式业务实现，02–37功能开发尚未开始。

## 本轮验证（2026-11-15）

使用独立 Chrome 与 agent-browser 验证文件/Git tab、四种改动来源、文件定位/搜索/预览、跨工作区状态保留、设置内插件配置、浅深/系统主题、390px文件树与预览切换、Escape关闭回焦、无页面横向溢出、输入增高和重置保留主题。页面错误记录为空。

1440×940下浅深几何完全相同：左栏280、中央740、右栏420，输入卡98高，标题/视图条44+32。语法检查与代码审查通过；不代表真实文件/Git/Agent功能已实现。截图为 preview-light.png、preview-dark.png、preview-mobile.png。此前因浏览器工具停用而未做的改后复查已在本轮独立浏览器中补做。

## 顶部与输入区简化

2026-11-15：中央顶部收为一行会话标题与必要图标，删除重复面包屑、对话tab及顶部原型/参考文字。输入卡底部左侧为权限模式，右侧为Agent与模型配置；状态/占用在卡外，结束运行在更多菜单。权限只改变当前会话的内存示例配置，不自动批准已有请求。

已实测权限模式按会话隔离、切主题保留、模型配置回显、待处理请求仍需单独响应。390px窄屏底部配置会自然换行，无页面横向溢出。最新截图：preview-header-light.png、preview-header-dark.png、preview-header-mobile.png。
