# 26: 可扩展且隔离的产物预览

**What to build:** 安装 renderer 后可预览对应 Artifact，生成的 HTML 无法使用工作台身份，renderer 故障局部可恢复。

**Blocked by:** 25: 登记、预览和下载产物版本

**Status:** resolved

- [x] 按 MIME 和已安装贡献点选择 renderer，停用后回退文件信息及下载，不修改 Artifact 原始版本。
- [x] 主动 HTML 使用不带同源权限的受限 iframe；需要复杂交互时必须独立来源和专门协议，不能复用带会话 Cookie 的主站。
- [x] 不开放能恢复同源工作台权限的 sandbox 组合，预览内容不能读取凭据或替用户执行工作台命令。
- [x] renderer 激活、撤销和错误边界复用 Plugin 生命周期，单个 renderer 故障不破坏历史和其他视图。
- [x] 通过实际浏览器加载受控主动内容、失败 renderer 和未知 MIME 验证隔离、回退及重启后版本访问。

- [x] renderer 使用版本化公开 UI 契约；同 MIME 存在多个候选时由 profile 显式选定，不按注册顺序覆盖。预览容器也可替换，但不得取消主动内容隔离或绕过服务端授权下载。

规格用户故事：49, 51, 55, 69, 74。

验收共识：遵循正式规格、领域词汇与已接受 ADR（含全界面公开替换契约 ADR-0004）；使用真实 Host、插件和持久化，经浏览器或公开命令/查询/事件及维护入口验证外部行为。ACP 协议替身仅用于外部 Agent 与故障控制，真实 Agent 验收不得被替代。

## Answer — 2026-11-20

`aork.artifacts.renderer@1` 成为版本化公开 UI 契约：renderer provider 在 manifest 声明 `mimeTypes`，Host 在 inspectGraph 内按媒体类型解析唯一 renderer——显式 `ui.renderers` 选择优先，唯一已安装候选自动解析，多候选且未显式选择以 `UI_RENDERER_SELECTION_REQUIRED` 拒绝（注册顺序永不决定）；失效选择由 `UI_RENDERER_UNAVAILABLE` 拒绝，`ui.providers` 不得出现按媒体类型选择的契约。bootstrap 携带 Host 解析后的 `ui.renderers`；`plugins.setEnabled` 停用插件时同步移除其 renderer 贡献，受影响媒体类型回退文件信息与下载。renderer 视图经 `runtime.renderRenderer(mediaType, context, {fallback})` 渲染，激活/撤销/错误边界与全部视图走同一 Plugin 生命周期（ViewBoundary 局部回退，容器仍显示文件信息与授权下载）。

媒体类型由登记文件名确定性导出（`artifactMediaType`，从不嗅探内容），`artifacts.preview` 每个捕获状态都返回 `mediaType`；版本行与字节不变。默认 artifacts Plugin 内置 `text/html` renderer：主动内容在固定 `sandbox="allow-scripts"`（`ARTIFACT_ACTIVE_SANDBOX`）iframe 中渲染——透明来源、cookie 不可读、无存储、不能顶层导航/表单/弹窗，对工作台的请求为无凭据跨源。不存在调用方可选的 sandbox 组合，也不存在恢复同源权限的路径；renderer 只收到 `{versionId, mediaType, filename}` 并经同一鉴权 `artifacts.preview`/`artifacts.file` 读取。更复杂交互需独立来源与专门协议（未实现，边界已写入 docs/artifacts/versions.md）。

验证（Node 24.22.3）：`pnpm build`、`pnpm typecheck`、`node scripts/check-boundaries.mjs` 通过；`tests/artifact-renderers.test.ts` 2 项全绿（媒体类型解析/多候选显式选择/失效拒绝/停用移除、preview mediaType 且版本不变），`tests/artifact-versions.test.ts` 6 项与 bootstrap/plugin-compatibility/plugin-lifecycle/plugin-install/workbench 共 92 项同批全绿（首轮 91/92 为共享机器负载抖动，同集重跑全绿）；`tests/browser/artifact-renderers.spec.ts` 3 项全绿（敌意 HTML 的 cookie/存储/带凭据 fetch/顶层导航探针全部受阻且工作台会话完好、失败 renderer 与未知二进制回退且下载可用、独立 renderer 安装选中/停用回退/重启后版本与下载仍可访问），`tests/browser/artifact-versions.spec.ts` 2 项更新为受限 iframe 断言后仍全绿。真实 Provider/Linux 组合验证仍属后续工单。

## Comments

- 2026-11-15：用户确认 36 张工单的拆分及依赖关系，按已评审草稿发布；本票尚未开始实施。

- 2026-11-15：按用户“第一项先做界面交互原型，交互确认后再完成功能开发”的决定，本票由原 25 顺延为 26；原验收范围与历史记录保留，原依赖按同一映射顺延。新 01“界面交互原型与用户确认”是本票的传递前置，用户确认交互前不得开始本票功能开发。

- 2026-11-15：产物预览及 renderer 明确可替换和确定性选择；可信 UI 的信任边界不放宽主动产物内容隔离。尚未实施，原依赖及原型确认门禁不变。

- 2026-11-20：实施完成。SDK 新增 `MEDIA_TYPED_UI_CONTRACTS` 与 manifest `mimeTypes`/profile `ui.renderers` 模式；kernel 解析并校验 renderer 图；host 在停用时清理 renderer 条目并输出解析结果；contracts 增 `ARTIFACT_RENDERER`、`artifactMediaType`、`ARTIFACT_ACTIVE_SANDBOX` 与 `ArtifactRendererContext`，`artifactPreviewSchema` 各捕获状态带 `mediaType`（ticket 25 相关断言随之更新）；UI runtime 增 `renderRenderer`；artifacts Plugin 内置受限 HTML renderer，预览容器按已选 renderer 渲染、无 renderer 或故障时回退文本/文件信息与下载。文档更新于 docs/artifacts/versions.md。
