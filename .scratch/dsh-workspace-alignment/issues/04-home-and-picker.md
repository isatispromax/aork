# 04: 移除中央页面、首页与选择器

**What to build:** 删除「所有工作区」卡片页、工作区详情页与导航入口（`page=workspaces`），`aork.workspace.page@1` 未选中会话时渲染新建会话；退役 `aork.workspace.workspace-page@1` 与 `aork.workspace.browser@1`。目录选择器注册为公开视图 `aork.workspace.directory-picker@1`；新建会话的工作区选择器增「添加工作区…」，登记成功后选中。添加工作区成功后直接进入该工作区的新建会话。

**Blocked by:** 03

**Status:** resolved

- [x] 首页、选择器、目录选择器视图
- [x] 浏览器测试（auth / plugin-install / plugin-lifecycle 等以首页为落点的用例同步）

实现备注：
- `aork.workspace.page@1` 在未选中会话时把地址规范为 `createSession=1`（`page=` 页面除外），所以取消、刷新、链接含义一致。
- 目录选择器视图 portal 到 body，并阻止其内部「前往」表单的 submit 冒泡：初版在选择器菜单里打开时被渲染在新建会话的 `<form>` 内，冒泡的 submit 把对话框带没了。
- 已知偏离：登记失败留在目录选择器内原地显示（dsh 为独立错误对话框 + 重新选择）；空态不重复放「添加工作区」按钮（工具栏已有）。
