# 06: 文档同步与全量验证

**What to build:** 文档与全量验证收口。

**Blocked by:** 01-05

**Status:** open

- [ ] `docs/workbench/navigation-and-reading.md`：组成表（右栏扩展目标 inspector-tabs、默认内容 Files 停靠 tab）、偏好段落（dock 每会话持久化、拖拽排序）、设置层描述、归档行更新。
- [ ] `docs/sessions/history.md`、`README.md` 工程边界表（workbench/sessions/workspace 行）更新。
- [ ] `pnpm typecheck`、`pnpm check:boundaries`、全量 `vitest`、`pnpm exec playwright test` 全绿。
- [ ] 验证期间不并行运行 `pnpm dev` 监听（既有 dist 竞态）。
