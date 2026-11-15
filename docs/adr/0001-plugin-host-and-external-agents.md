# 采用插件化宿主，由外部 ACP Agent 执行工作

2026-11-15：根据已确认的单用户远程通用工作台方向，选择一个 TypeScript 长驻宿主，业务全部由插件组成；Claude／Codex 通过 ACP 成为会话执行主体，宿主不包含主 Agent 推理循环。直接 fork dsh 容易继承其模型历史与工具循环的所有权假设，而为所有插件拆独立服务会提前引入分布式运维成本。

插件默认同进程，Agent 独立进程；这提供组合和故障管理能力，不构成恶意插件或多租户安全沙箱。更强隔离通过未来 runner／插件宿主实现扩展。

技术细节见[架构基线](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/technical-architecture.md)。本决策尚无运行验证。
