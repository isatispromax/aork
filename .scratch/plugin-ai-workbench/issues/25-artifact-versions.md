# 25: 登记、预览和下载产物版本

**What to build:** 用户显式登记工作结果为 Artifact，查看来源和版本，预览基础文本或下载未知格式文件。

**Blocked by:** 12: 完成文本执行轮次并随时取消

**Status:** resolved

- [x] Artifact 显式登记而非自动把全部工作区文件归因于 Agent；版本关联 Project、来源 Session/Turn 及内容引用。
- [x] 内容版本不可变，外部引用明确标识；可变工作区文件与导出版本区分。
- [x] 文件经临时写入、完整校验和原子改名后登记元数据；失败不产生虚假成功，孤立内容可回收，不假装文件与数据库同一事务。
- [x] 基础文本预览、版本选择、文件信息与授权下载贯通浏览器和公开接口，未知格式始终有下载途径。
- [x] 通过实际文件变更与重复登记命令验证版本稳定、来源、幂等、失败和引用保护；归档不级联删除仍被引用的版本。

- [x] 产物列表、版本选择与基础预览使用公开 UI 契约，替换 UI 仍调用 artifacts 的查询／下载入口，保留稳定版本及来源，不将元数据或领域存储转交视图所有。

规格用户故事：47, 48, 49, 74。

验收共识：遵循正式规格、领域词汇与已接受 ADR（含全界面公开替换契约 ADR-0004）；使用真实 Host、插件和持久化，经浏览器或公开命令/查询/事件及维护入口验证外部行为。ACP 协议替身仅用于外部 Agent 与故障控制，真实 Agent 验收不得被替代。

## Answer — 2026-11-17

`artifacts` Plugin 在默认组合内交付（`plugins/artifacts/`，显式 filesystem.read/write grant）：`artifacts.register` 是 durable command，仅用户显式选择的来源（工作区文件不可变副本或 credential-free http/https 外部引用）产生版本；版本按事务分配 ordinal，关联 Project、经验证的 Session/Turn 关联（`registered-by-user`，不声称 Agent 创作）与内容引用（contentId/sha256/size/filename）。所有者、Project、Workspace、Session/Turn 与归档状态在 prepare 与提交事务内双重校验；外部引用只存 URL 元数据，不获取远端字节。

内容发布走私有 0700 内容库：staged 临时写入（0600、O_EXCL/O_NOFOLLOW）→ fsync → 重读校验和 → 原子改名 bytes → 目录 sync → 复核读取，之后才登记元数据；不宣称文件系统与 SQLite 是一个事务。元数据提交失败（含真实竞争 SQLite 写锁导致的 STORAGE_UNAVAILABLE）不产生回执、事件或版本行；不可证明结果的已发布对象保留为孤立内容，`artifacts.collectOrphans` 分页回收且以全部已记录版本（含归档）为保留根。归档只标记 Artifact，版本、字节、来源与下载保留。预览按 UTF-8 文本（≤256KiB）／unsupported／too-large／external-reference 区分，detail/list/file/preview 均为有界、鉴权的公开 snapshot/resource；未知格式始终有文件信息与下载。

四个 UI 契约（registration/list/versions/preview）由 profile 显式选择，经工作台菜单上下文组合；`tests/fixtures/artifacts-view` 独立构建安装的替换 UI 经同一公开 command/snapshot/resource 完成登记、列表、版本切换、预览与下载，URL 选择 Project 作用域并保留无关键。

验证（Node 24.22.3）：`pnpm build`、`pnpm typecheck`、`node scripts/check-boundaries.mjs` 通过；`tests/artifact-versions.test.ts` 6 项全绿（不可变有序版本＋来源＋跨重试/重启幂等回执、外部引用与 scheme 拒绝、所有权/Project/Workspace/Session 拒绝、未知/超大格式与未认证 401、归档保留与回收器引用保护、发布后真实 SQLite 写锁失败的孤立回收）；`tests/browser/artifact-versions.spec.ts` 2 项全绿（默认 UI 上下文捕获/固定版本/390px/脚本不执行，独立替换 UI 全流程＋重启）。完整 vitest 在共享机器高负载下多轮 261–268/269，失败均为既有重启密集型计时用例轮换（同负载下无 artifacts 的集成基线为 256/263，更差），受害文件单独重跑全绿；完整 Playwright 89/90，唯一超时用例重跑 5/5 全绿。真实 Provider/Linux 组合验证仍属后续工单。

## Comments

- 2026-11-17：接手 5194154 之后的在制工作（WIP 提交 3b7885f 保全后合并 cd25ca8）。补齐验收测试（外部引用、拒绝矩阵、未知格式、归档保留、发布后存储失败孤立回收）、独立替换 UI fixture 与浏览器用例、`docs/artifacts/versions.md`。修正：authorization 改为 optionalRequires（对齐其他业务插件，认证降级主机仍可启动，artifacts 操作在授权缺失时以 AUTH_UNAVAILABLE 拒绝）；bootstrap 默认插件清单纳入 artifacts；默认 UI 事件清理包装 Disposer。

- 2026-11-16：12 及后续输入／恢复核心已完成，25 开始显式产物版本流程。接口计划 `/tmp/aork-artifact-architecture-plan.md` 仅为参考；按已确认紧凑会话／文件菜单作上下文集成，不恢复独立产物导航。文件发布与元数据事务分开，失败不产生虚假版本，所有历史版本和引用保留。

- 2026-11-15：用户确认 36 张工单的拆分及依赖关系，按已评审草稿发布；本票尚未开始实施。

- 2026-11-15：按用户“第一项先做界面交互原型，交互确认后再完成功能开发”的决定，本票由原 24 顺延为 25；原验收范围与历史记录保留，原依赖按同一映射顺延。新 01“界面交互原型与用户确认”是本票的传递前置，用户确认交互前不得开始本票功能开发。

- 2026-11-15：产物界面属于全部正常 UI 替换范围，数据所有权和不可变版本语义保持不变。尚未实施，原依赖及原型确认门禁不变。
