# Aork SDK 隔离底层框架，插件以独立产物安装

2026-11-15：选择 `@deepseek-ai/cordis` 4.1.0 作为私有生命周期与 DI 基础，公开插件只依赖 Aork SDK。dsh 使用的是经过修补的发行分支；直接公开它的 Context／Loader 会把第三方插件绑定到内部框架和部署配置。

server／client 插件均产出独立预构建 ESM，Host 在运行时装配；UI 共用宿主提供的 React 与 UI runtime。安装新包不要求重建工作台，升级采用排空全部 Run、迁移、重启和页面刷新，暂不做 HMR。代价是必须从首版实现 manifest 校验、共享依赖约束和产物加载器，而不能把静态编译进应用的模块宣传为开放安装能力；Host 重启会中断全部运行，首版不承诺无停机安装。

详见[插件 SDK 与分发](/Users/yangdi/code/multai/Aork/.scratch/plugin-ai-workbench/technical-architecture.md)。这是本轮选定方案，尚无实现验证。
