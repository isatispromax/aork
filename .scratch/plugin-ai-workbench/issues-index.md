# Aork 首版实施工单索引

当前共 37 张独立工单。2026-11-15 用户在原 36 张工单发布后明确要求“第一项先做界面交互原型，交互确认后再完成功能开发”；据此新增 **01 界面交互原型与用户确认**，原 01–36 顺延为 02–37。各工单的状态以其文件为准，本索引用于导航和显示依赖。

父规格：[Aork 插件化 AI 工作台](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/spec.md)。先调整执行顺序，保留原 36 张功能工单的全部验收范围和历史记录；随后按用户明确要求，在父规格和相关工单补充全部正常界面的公开插件替换契约，新增故事 73–78。父规格保持开放，实现进度以各票验收和下文记录为准。

**第一步是原型与用户确认。** 2026-11-15 用户明确确认当前 D 版本并授权继续全部规格，01 已完成。原型仅模拟界面和内存状态，不证明任何正式功能已实现。02 及后续功能票按各自前置依赖执行；`ready-for-agent` 不会绕过尚未完成的依赖。

编号映射：旧编号统一加 1，即原 01 → 02、原 02 → 03，依此至原 36 → 37。原“默认插件启动与受保护入口”保留为 02，并新增直接前置 01；其余工单保留原依赖图语义，仅同步前置编号。历史 Comments 中的“36 张工单”保留为当时批准记录，不代表当前总数。

每张工单列出直接阻塞关系和验收条件。只有全部前置工单完成后才能执行。

当前进度：**2026-11-15 用户确认 D 原型后，01、02、03 已 resolved。03 按用户更正实现 dsh 风格 Token 链接换签名 Cookie，无账号或输入表单；本机 macOS 最终行为测试 19/19、浏览器测试 12/12 通过，证据见 [03](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/03-single-user-login.md#answer)。04、07 的直接前置已解除；其余按依赖推进。未进行远程部署，Linux 与真实 Agent 专属验收尚未完成。**

全界面契约：默认与独立 UI Plugin 均可替换正常产品界面，profile 显式选定独占提供者，多项扩展可排序／隐藏；宿主仅保留最小引导／错误兜底。约束见 [ADR-0004](/Users/yangdi/code/multai/Aork/docs/adr/0004-replaceable-product-ui-contracts.md)。工单总数和依赖图不变；新的故事映射如下，功能通过须以实际验收为准。

| 新增故事 | 实现及验收工单 |
| --- | --- |
| 73 整体布局与主要导航可替换 | 01 交互评审；02 契约原语、04 独立装配、10 会话列表、18 工作台组合；35 独立替换验收 |
| 74 工作交互和内容界面可替换 | 01 交互评审；08 文件、12 输入／消息、15 审批、16 表单、17 能力输入、18 组合、25–26 产物；35 行为一致验收 |
| 75 登录／设置／管理／菜单／通知可替换 | 01 交互评审；02 启动、03 登录、04 独立装配、06 管理、18 菜单／通知；35 独立替换验收 |
| 76 显式选择与扩展排序／显隐 | 01 交互评审；02、04–06 组合机制、18 工作台；35 确定性验收 |
| 77 公开 UI 版本与统一主题／图标 | 01 交互评审；02、04–06 公共契约、18 组合；35 全界面验收 |
| 78 停用／失败／失效图和权限可恢复 | 01 交互评审；02–03 兜底与权限、05–06 诊断／生命周期、18 错误呈现；35 撤销及恢复验收 |

| 编号 | 工单 | 直接前置 |
| --- | --- | --- |
| 01 | [界面交互原型与用户确认](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/01-interface-interaction-prototype.md) | 无 |
| 02 | [默认插件启动与受保护入口](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/02-default-plugin-bootstrap.md) | 01 |
| 03 | [访问 Token 与浏览器会话](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/03-single-user-login.md) | 02 |
| 04 | [独立安装一个服务与界面插件](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/04-independent-plugin-install.md) | 03 |
| 05 | [插件兼容性检查与失败诊断](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/05-plugin-compatibility-diagnostics.md) | 04 |
| 06 | [配置、启停与恢复插件](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/06-plugin-lifecycle-management.md) | 05 |
| 07 | [创建项目与普通目录工作区](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/07-projects-and-workspaces.md) | 03 |
| 08 | [浏览和操作工作区文件](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/08-workspace-file-workflow.md) | 07 |
| 09 | [管理 Agent Profile 与服务器凭据引用](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/09-agent-profiles-and-credentials.md) | 07 |
| 10 | [创建会话并查看历史索引](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/10-session-creation-and-history.md) | 09 |
| 11 | [准备与结束运行，落实工作区占用](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/11-safe-run-lifecycle.md) | 06、08、10 |
| 12 | [完成文本执行轮次并随时取消](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/12-streaming-turn-and-cancel.md) | 11 |
| 13 | [后续输入排队与显式继续](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/13-queued-turns.md) | 12 |
| 14 | [浏览器断线后的状态恢复](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/14-snapshot-and-reconnect.md) | 12 |
| 15 | [一次性响应权限请求](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/15-permission-interactions.md) | 12 |
| 16 | [按协商能力回答结构化问题](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/16-structured-input.md) | 15 |
| 17 | [按 Agent 能力配置输入和参数](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/17-negotiated-input-and-settings.md) | 12 |
| 18 | [全局待处理、未读与工作台导航](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/18-pending-unread-and-navigation.md) | 14、16 |
| 19 | [在 Linux 上运行远程工作台](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/19-linux-remote-deployment.md) | 14 |
| 20 | [Claude 真实远程接入](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/20-claude-provider-basic.md) | 15、19 |
| 21 | [Codex 真实远程接入](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/21-codex-provider-basic.md) | 15、19 |
| 22 | [崩溃和重启后的运行核对](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/22-interruption-reconciliation.md) | 13、14、15 |
| 23 | [按能力恢复原生会话](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/23-native-session-recovery.md) | 22 |
| 24 | [让 Agent 调用选定的工作台工具](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/24-scoped-mcp-tools.md) | 12 |
| 25 | [登记、预览和下载产物版本](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/25-artifact-versions.md) | 12 |
| 26 | [可扩展且隔离的产物预览](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/26-safe-artifact-renderers.md) | 25 |
| 27 | [复用成果与关联新会话](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/27-context-reuse-and-handoff.md) | 17、25 |
| 28 | [完成无 Git 的资料处理工作流](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/28-noncoding-document-workflow.md) | 24、26、27 |
| 29 | [增加 Git 与 diff 编码工作流](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/29-coding-git-diff-plugin.md) | 24 |
| 30 | [存储故障、数据保留与慢客户端诊断](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/30-bounded-storage-and-failure-behavior.md) | 14、24、25 |
| 31 | [维护前停止接单并确认全部运行结束](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/31-maintenance-drain.md) | 22、24 |
| 32 | [生成完整工作环境的一致备份](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/32-consistent-backup.md) | 25、31 |
| 33 | [恢复匹配批次并校验外接目录](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/33-batch-restore.md) | 32 |
| 34 | [插件升级、迁移与匹配回退](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/34-upgrade-migration-and-rollback.md) | 19、33 |
| 35 | [验证新插件与 Provider 可替换性](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/35-plugin-replacement-conformance.md) | 18、28、29、34 |
| 36 | [Claude 首版完整 Linux 验收](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/36-claude-full-acceptance.md) | 20、23、30、35 |
| 37 | [Codex 首版完整 Linux 验收](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/issues/37-codex-full-acceptance.md) | 21、23、30、35 |

## Comments

- 2026-11-15：按用户确认的拆分发布；覆盖规格中的 72 条用户故事，依赖编号按前置优先排列。

- 2026-11-15：此前用户已确认并发布 36 张独立工单，初始标签均为 `ready-for-agent`；该批准历史及各票原验收条件完整保留。
- 2026-11-15：按用户新增决定，将界面交互原型与用户确认设为新 01；原 01–36 顺延为 02–37，共 37 张工单。用户确认交互前，后续全部功能开发保持阻塞。本次顺延并不表示原型已验收或功能已实现。

- 2026-11-15：第 01 项初版原型已通过基础浏览器交互检查，转为等待用户确认；正式功能开发门禁未解除。
- 2026-11-15：根据用户“所有界面都可以通过插件定制修改”的新要求，规格补充连续故事 73–78（共 78 条），同步相关票验收及 ADR-0004；仍为 37 张工单，未增删编号或改变依赖。原始“72 条故事”评论保留为当时发布记录。01 继续 needs-info，文档约束不是机制实现或测试通过的证据。

- 2026-11-15：原型评审按最新反馈收敛为会话＋文件＋Git改动，插件配置归入设置，移除资料/产物、界面定制和个人工作台入口；01仍为needs-info，实施范围在交互确认后按最新设计复核，未自动撤销或启动后续功能票。
