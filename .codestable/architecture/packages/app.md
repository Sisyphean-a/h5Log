# 应用

scope: package:app
context: [remote-logging](../../requirements/contexts/remote-logging.md)

## 边界

一个 Node.js 进程接收与保存日志、分发到所有查看者，并托管 Vite 构建的工作台页面。数据只存在内存，不拥有 Android 设备或业务登录会话。工作台按客户端定位日志，不承担监控分析或远程操控手机；生产产物由日志服务托管在域名根路径。

## 入口与契约

日志服务：

- src/server/index.ts：createLogServer；POST /api/logs 整批校验后写入，GET /api/logs 筛选分页和返回范围内会话，GET /api/logs/:id 返回日志及同客户端同会话的关联请求，GET /api/stream 分发事件，GET /api/health 返回保留资源与运行状态。
- src/server/store.ts：LogStore 拥有接收时间、过期（默认 12 小时，`RETENTION_HOURS` 可配）、条数/字节淘汰（默认 2,000 条 / 4 MiB）、保留窗口内去重、客户端与会话聚合、请求关联。id 用于本进程分页，serverId 区分重启。淘汰的数组槽立即解除日志对象引用，并按游标分段压缩。
- src/server/cli.ts：监听和关闭，读取 `PORT`、`HOST`、`MAX_LOGS`、`MAX_MEMORY_MB`、`RETENTION_HOURS`、`ALLOWED_ORIGINS`，托管构建后的 dist/web。容量上限保持保守默认值，内存占用落在几十 MiB；调大上限才需要放宽 V8 堆参数。SIGINT/SIGTERM 等待连接关闭，五秒后关闭剩余连接。
- SSE 慢消费者与连接数量受限；一个查看者断开不影响其他查看者。查看者重连后通过查询接口回读保留日志。
- 清理事件把服务端 expiresBefore 和容量淘汰游标 evictedThroughId 发给工作台，客户端立即丢弃已经淘汰的行，并按水位刷新列表和会话索引；保留期限不依赖查看者电脑时钟。来源白名单是 CORS 控制，不是身份认证；首版没有内置用户或权限系统，部署入口归反向代理。

工作台：

- index.html、src/web/main.ts：客户端选择、应用/环境/会话/来源/级别/关键词筛选、复制、导出本页、自动滚动、视图清空、每页 200 条历史翻阅。筛选写入地址栏，刷新和分享可恢复。
- src/web/inspector.ts：按需展开结构和原始事件，按请求标识读取同一客户端与会话内的收发记录；响应未到、被淘汰或服务重启均明确提示。
- src/web/style.css：浅色、低噪声的沉静工作台；主视线留给日志，客户端列表承担切换和错误信号。
- SSE 与查询配合；查询期间按当前筛选缓存最多 200 条匹配日志，全局游标独立推进，缓冲溢出仍保留历史入口。后退缓存恢复时重建流并回读保留日志。历史页停留时继续接收连接更新，回到实时后重新读取最新页。每个浏览器单独持有筛选和清空状态。
- 日志内容通过 textContent 显示，不执行日志中的 HTML。实时追加复用已有行，保留展开内容、文本选择和键盘焦点。设备状态只描述最近上报，不伪造在线/离线。
- 会话计数基于服务端日志页快照和其后的 SSE 增量；迟到的快照范围内事件按全局 id 游标忽略。加载期间按事件 id 去重并计数，不因显示缓冲截断而少计；容量淘汰水位或增量缓冲溢出时重新读取当前页和会话索引。索引请求与新日志并发时以 revision 检测并重读，防止旧索引覆盖新会话。服务器重启后分页 id 与容量淘汰水位同时重置。
- demo.html、src/web/demo.ts：真实 SDK + Axios 接入演示，不伪造工作台日志。

构建：服务端由 vite.config.server.ts 打包为自包含单文件 dist/server/cli.mjs（只外部化 node: 内置模块），页面由 vite.config.ts 构建到 dist/web；dist 就是部署产物，运行时不需要 node_modules。

运行配置与代理示例见 [根 README](../../../README.md#部署)，契约证据在 packages/app/test/。
