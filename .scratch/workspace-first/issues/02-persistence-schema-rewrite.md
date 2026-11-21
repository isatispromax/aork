# 02: 持久化 schema 重写（改历史 migration + 清库策略）

**What to build:** 按用户决定「数据可弃、不写迁移」，直接修改既有 migration 声明并接受旧库作废；迁移运行器机制不改。

**Blocked by:** 01: 契约层移除 Project，Artifact 改挂 Workspace

**Status:** ready-for-agent

- [ ] `plugins/workspace/src/persistence/repository.ts`：v1 migration 重写——删除 `plugin_workspace__projects` 表；`plugin_workspace__workspaces` 去掉 `project_id` 列、外键与 `plugin_workspace__project_id` 索引，主键与 record 结构保留；v2 claims 表不动（L13-17）。
- [ ] 同文件：`insertProject`/`project`/`updateProject`/`insertWorkspace` 语句与函数签名去 project 参数（L22-45）。
- [ ] `plugins/artifacts/src/persistence/repository.ts`：`plugin_artifacts__artifacts` 的 `project_id` 列与 `plugin_artifacts__project(principal, project_id, id)` 索引改为 workspace 键；`list`/`insert` 语句同步（L5-28）。
- [ ] sessions/workbench record JSON 内嵌 projectId 不做兼容读取（随清库作废）。
- [ ] 全新数据目录建库启动成功；含旧 checksum 的数据目录启动报错信息明确指向「清空数据目录」（README 措辞由 ticket 09 落地，本票保证报错不误导为数据损坏）。

规格用户故事：7, 9。

验收共识：遵循 ADR-0005 的数据可弃决策；不扩展 `packages/storage/src/durable.ts` 的迁移机制（保持只允许 CREATE 的现状）；本票不依赖任何存量数据可用。

## Comments

- 2026-11-21：grilling Q12 决定「直接改历史 migration + 清库」，拒绝扩展迁移运行器支持 DROP/ALTER 的方案（一次性成本不划算）。
