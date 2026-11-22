# 01: 三栏区域的公开契约与扩展点

**What to build:** 在 `@aork/sdk/client` 与 `@aork/contracts/workbench` 中新增右栏容器契约、三个区域内扩展点，并把布局偏好改名为 inspector 语义（含旧记录兼容读取）。

**Blocked by:** 无

**Status:** resolved

- [x] `UI_CONTRACTS` 增加 `aork.workbench.inspector@1`；`UI_EXTENSION_TARGETS` 增加 `aork.workbench.rail-sections@1`、`aork.workbench.inspector-sections@1`、`aork.workbench.conversation@1`。
- [x] `packages/contracts/src/workbench.ts` 增加四个契约常量；`preferencesSchema` 字段改为 `inspectorOpen`/`inspectorWide`；新增 `readPreferences(value)` 严格解析 + 旧 `filesOpen`/`filesWide` 归一。
- [x] `defaultPreferences` 更新；`WorkbenchLayoutContext` 保持不变。
- [x] kernel 的 manifest/profile 校验无需改逻辑即可接受新契约与新扩展目标（由既有 `UI_CONTRACTS`/`UI_EXTENSION_TARGETS` 查表完成），补测试断言。
- [x] `profiles/personal-server.json` 增加 `aork.workbench.inspector@1` 选择，缺失时 doctor 报 `UI_PROVIDER_UNAVAILABLE`。

规格：用户故事 5、7；Implementation Decisions「公开契约」「偏好兼容」。
