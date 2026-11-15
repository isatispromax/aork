# 10: 创建会话并查看历史索引

**What to build:** 用户选择 Project、Workspace 和 Profile 创建 Session，通过导航查看关联环境并归档保留历史。

**Blocked by:** 09: 管理 Agent Profile 与服务器凭据引用

**Status:** claimed

- [ ] Session 与 Run、Turn 分开，创建命令保存稳定身份、环境选择和配置引用，不自动宣称有 Agent 正在运行。
- [ ] 创建 Session 使用既有命令幂等约束，重试不重复创建；浏览器展示 Agent、实际工作目录及尚未启动状态。
- [ ] 会话列表、详情与项目/工作区导航连通，URL 可恢复实体选择，查询受身份和访问范围约束。
- [ ] 归档后保留历史与关联，不级联删除工作区或产物；尚无原生状态时明确不能原生恢复。 归档不能证明 Run 已停止或用于释放 Claim；存在活跃运行时必须沿用运行控制规则。
- [ ] 通过浏览器和重启后的公开查询验证创建、导航、归档、重复命令与错误引用。

- [ ] 会话列表、创建入口与详情使用公开 UI 视图契约并保持实体选择接口，替换后仍以相同 Session 身份查询；不把这些视图固化在宿主 Shell 或私有布局子树。

规格用户故事：5, 14, 15, 41, 54, 73。

验收共识：遵循正式规格、领域词汇与已接受 ADR（含全界面公开替换契约 ADR-0004）；使用真实 Host、插件和持久化，经浏览器或公开命令/查询/事件及维护入口验证外部行为。ACP 协议替身仅用于外部 Agent 与故障控制，真实 Agent 验收不得被替代。

## Comments

- 2026-11-15：用户确认 36 张工单的拆分及依赖关系，按已评审草稿发布；本票尚未开始实施。

- 2026-11-15：按用户“第一项先做界面交互原型，交互确认后再完成功能开发”的决定，本票由原 09 顺延为 10；原验收范围与历史记录保留，原依赖按同一映射顺延。新 01“界面交互原型与用户确认”是本票的传递前置，用户确认交互前不得开始本票功能开发。

- 2026-11-15：会话列表和主视图必须可由独立 UI 提供者替换，领域身份与创建／归档规则不变。尚未实施，原依赖及原型确认门禁不变。

## Answer

2026-11-16：实现与本机验证已完成，保持 `claimed` 等待独立代码审查及最终集成检查。实现说明见 [Session 与历史](/Users/yangdi/code/multai/Aork/docs/sessions/history.md)。

- 新增独立 `sessions` 插件和 `@aork/contracts/session`。Session UUID、Project／Workspace／Profile 引用及不可变配置选择独立保存；创建不生成 Run、Turn、ACP prompt 或 Claim。默认实例不加入虚构 Project、Profile 或 Session。
- 创建经 Workspace／Profiles 的公开语义服务在同一事务验证；错误跨引用、归档环境及缺失引用被拒绝。配置快照不含原生状态路径、launch、环境或私有插件配置，Profile 编辑不改写历史选择。
- `sessions.create`／`sessions.archive` 复用单写者、短同步事务及命令幂等原语；同内容重试返回原回执，异内容冲突，状态／事件／回执原子提交。浏览器接受后丢失响应的真实网络故障测试证明重试只保留一个 Session。
- 已认证 `sessions.overview` 和有界 `sessions.detail` 资源按主体读取历史。归档或物理目录删除不会移除历史／引用；Workspace 所有者的异步 `inspectDirectory` 复用文件服务的路径、设备／inode 和访问验证，只返回可用性。它不证明可启动或占用可释放。
- 公共 `aork.sessions.navigation@1`／`create@1`／`detail@1` 由 Workspace 浏览器组合，保留 Files 公共子视图与 URL 实体选择。单独构建并经公开安装入口选择的替代 UI 同时替换三个视图，在同一公开 Session 身份上创建、导航、刷新及重启查询。
- 归档不停止执行、不释放 Claim；公开同步生命周期参与者可拒绝归档，注销后按不可验证处理并拒绝，直至相同稳定 ID 恢复。真实 Run 权威接入仍属 11；没有原生历史时明确显示不能恢复。
- macOS 27.2.1／arm64、Node 24.22.3 ABI137、pnpm 10.30.2：冻结安装、build、typecheck、边界与 diff 检查通过；完整 Host **112/112**、完整 Chromium **23/23**。最终 UI 的 IME／草稿刷新修复另经新 build/typecheck 和三项 Session Chromium 流程通过。测试 Provider 独立包只执行真实版本探测，不替代真实 Agent 执行验收。未部署、推送或进行 Linux／远程／备份恢复验收。
