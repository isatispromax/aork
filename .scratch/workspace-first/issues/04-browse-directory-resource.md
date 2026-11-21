# 04: 服务端目录浏览资源（browse-only）

**What to build:** workspace plugin 新增面向新建工作区流程的单层目录浏览 resource，姿态按 grilling Q10 决定执行。

**Blocked by:** 01: 契约层移除 Project，Artifact 改挂 Workspace

**Status:** ready-for-agent

- [ ] `contracts/workspace.ts`：新增浏览请求/响应 schema（参数：服务器绝对路径；返回：单层 `FileEntry` 列表形态，不含 workspaceId，带 `truncated` 标记）。
- [ ] `plugins/workspace/src/server.ts`：注册 resource（命名建议 `workspace.browseDirectory`），授权走现有登录态（Cookie/CSRF/Origin 边界不变）。
- [ ] 实现：`opendir` 单层列举 + `lstat` 判 kind，不读文件内容；不跟随 symlink 展开（kind 标注即可）；排序 localeCompare、目录优先；复用 `FILE_LIMITS.entries` 500 条截断与字节上限。
- [ ] 错误在位返回：目录不存在与权限不足返回明确错误，不泄露超出的系统细节；拒绝 `..`、相对路径。
- [ ] dotfiles 原样返回（隐藏过滤在前端，ticket 05）。
- [ ] 新增单测：正常列出、symlink 标注、权限拒绝、不存在、截断、`..`/相对路径拒绝。

规格用户故事：2, 4。

验收共识：遵循正式规格与 ADR-0005；本资源是新的 fs 暴露面，严格 browse-only——不得顺带提供读内容/写/建目录能力；经真实 Host 单测与手测验证。

## Comments

- 2026-11-21：grilling Q10 安全姿态全盘采纳：单层元数据、不跟随 symlink、500 截断、登录态即可、在位报错。
