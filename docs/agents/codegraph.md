# CodeGraph

The repo is indexed by codegraph — a SQLite knowledge graph of every symbol, edge, and file (2,725 nodes / 6,570 edges over 247 files at init). Queries are sub-millisecond; the file watcher keeps the index within about a second of writes.

## Consult the graph first

- For "how does X work", architecture, where-is-X, or bug-hunting questions, call `codegraph_explore` first — it returns the verbatim source of the relevant symbols grouped by file, usually in one call.
- Use `codegraph_search` for name lookups, `codegraph_callers` / `codegraph_callees` for call flow, and `codegraph_impact` before any refactor to see what a change reaches.
- Reach for raw Read/Grep only to confirm a specific detail the graph didn't cover, or when the index is unavailable.
- Don't delegate a lookup to a sub-agent that the graph already answers — it repeats indexed work and costs more for the same result.

## Entry points

- **MCP tools** (`mcp__codegraph__*`) — ZCode sessions in this workspace auto-connect via `.zcode/config.json`. Prefer these.
- **CLI fallback** — the same queries from a terminal: `codegraph query|callers|callees|impact|affected|files|status`.

## Keep the index honest

- The watcher auto-syncs; you normally never index by hand.
- If results look stale or `codegraph_status` reports drift, run `codegraph sync .` before trusting the graph.
- If indexing is blocked by a stale lock, `codegraph unlock .`.
- Never edit or commit files inside `.codegraph/` — it is machine-local, self-gitignored, and fully regenerable from source.
