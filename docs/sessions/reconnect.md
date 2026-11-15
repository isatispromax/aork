# 浏览器快照与重连

浏览器断开只停止观察。Run、Workspace Claim、ACP prompt 和已排队 Turn 留在 Host；重连不会发送命令、继续暂停队列、取消运行或重试交付不确定的输入。

## 公开接口

Owner 通过 `context.snapshot(name, { maxBytes, read(parameters, request, token) })` 注册同步数据库参与者。Host 在一个 SQLite 只读事务中读取事件头和 Owner 状态，再返回 `{ snapshot, streamId, cursor }`。`ReadSnapshot` 与写事务不同，离开回调即失效；异步参与者、写入和嵌套写事务均失败。Owner 通过自己的 Repository 读取自己的表。Host 不读取插件私有表。

HTTP 为 `GET /api/snapshots/:name`，参数是有界字符串，必须携带当前 `X-Aork-Graph`。Session 的 `sessions.overview` 只含数据库投影，`sessions.timeline?sessionId=…` 含有界历史；物理目录检查有独立的新鲜度，不属于这个数据库快照。多个 Owner 的独立请求分别具有水位，不能当成一个全局原子快照。Owner 可在一个同步注册中通过明确服务参与者组合数据库读取。

客户端使用公开 SDK：

```ts
const stop = runtime.observeSnapshot('sessions.timeline', { sessionId }, {
  next(value) { applyValidatedTimeline(value); },
  error(error) { showReadFailure(error.message); },
}, { owners: ['sessions'] });
```

`next` 可以返回 Promise。SDK 先等待校验和应用完成，再更新已应用 cursor 并 ACK。相关事件只作失效通知，SDK 会重新取得一致快照；不猜测业务 payload，也不把接收事件当成应用成功。失败会重新同步。事件 ID 有界去重，序号通过十进制字符串和 BigInt 比较；跨身份或过滤 Owner 导致的序号间隙正常。查询缓存和订阅属于 UI Runtime，插件不接触缓存库的 Context。

临时网络错误不等于身份被拒绝：已有授权和已应用视图在探测请求的传输失败时保留，Host 对每次请求继续校验身份。初次进入仍需服务器授权。明确的未认证、授权服务不可用或撤销结果会清理受保护视图和订阅。

## WebSocket 协议

浏览器通过同源 `ws(s)://…/api/events?cursor=…&streamId=…&graph=…` 连接。URL 只有非秘密元数据，认证沿用 HttpOnly Cookie，必须有 Host 的规范 Origin。不会把启动 Token 放进 WebSocket URL。

服务端发送 `ready`，随后发送 `{kind:'events', events, cursor}`。客户端在成功应用后回复 `{kind:'ack',cursor}`。服务端每次从数据库读取 `seq > lastSent`，没有一次性回放切换到内存监听的空隙。异步投影的状态、它自己的浏览器事件和 offset 在投影提交中保存，不能用上游事实序号跳过尚未提交的投影。

每个 Host 启动使用新的 `streamId`。旧启动、旧备份、未来或非法 cursor、低于保留 floor 的 cursor 都要求新快照。服务端发送 `resync` 并关闭连接；新快照保留领域表中的历史，不依赖重放全部旧事件。替换图发送 `reload`；身份失效发送 `access`。客户端销毁相关订阅及受保护缓存，再按当前身份或插件图重新进入界面。

`resync`、`access` 和 `reload` 控制帧在替换 HTTP 读取期间仍立即处理。控制帧或断开会取消 UI Runtime 自己的快照读取；过期返回值不能进入应用或推进 cursor。已经开始的业务观察者应用仍先完成，随后才允许下一次应用，避免并发覆盖。

## 有界范围

| 范围 | 上限 |
| --- | --- |
| 已保留浏览器事件 | 2048 条，每个 payload 至多 32 KiB；领域记录不删除 |
| 每次读取及未 ACK 页 | 8 个事件，序列化帧至多 300 KiB |
| 出站缓冲检查 | 超过 512 KiB 关闭，不再读取下一页 |
| 应用 ACK 等待 | 5 秒，慢消费者重新同步；关闭后至多 250 ms 强制断开 |
| 客户端快照 HTTP 读取 | 8 秒；控制帧或断开会提前取消 |
| 入站帧 | 1024 字节，仅接受当前页 ACK，不启用压缩 |
| 连接 | 每个身份 32，总计 64 |
| 重试延迟 | 250 ms 至 5 秒 |
| 普通快照 | 注册声明上限，Host 最多允许 2 MiB |

空闲连接仍每 100 ms 检查数据库、当前图和原始 Cookie。授权服务使用短期 lease，连接不阻塞插件停用或授权更改。未落库 Runtime 内容不会作为已保存快照或事件发送。独立替换界面与默认界面使用同一公开接口。
