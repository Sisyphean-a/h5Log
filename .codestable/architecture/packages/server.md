# 日志服务

scope: package:server
context: [remote-logging](../../requirements/contexts/remote-logging.md)

## 边界

一个 Node.js 进程接收与保存日志、分发到所有查看者，并提供 Web 构建产物。数据只存在内存，不拥有 Android 设备或业务登录会话。

## 入口与契约

- src/index.ts：createLogServer；POST /api/logs 整批校验后写入，GET /api/logs 筛选分页和返回范围内会话，GET /api/logs/:id 返回日志及同客户端同会话的关联请求，GET /api/stream 分发事件，GET /api/health 返回保留资源与运行状态。
- src/store.ts：LogStore 拥有接收时间、12 小时过期、条数/字节淘汰、保留窗口内去重、客户端与会话聚合、请求关联。id 用于本进程分页，serverId 区分重启。淘汰的数组槽立即解除日志对象引用，并按游标分段压缩。
- src/cli.ts：监听和关闭，读取环境变量，托管 packages/web/dist。SIGINT/SIGTERM 等待连接关闭，五秒后关闭剩余连接。
- SSE 慢消费者与连接数量受限；一个查看者断开不影响其他查看者。查看者重连后通过查询接口回读保留日志。
- 清理事件把服务端 expiresBefore 和容量淘汰游标 evictedThroughId 发给工作台，客户端立即丢弃已经淘汰的行，并按水位刷新列表和会话索引；保留期限不依赖查看者电脑时钟。来源白名单是 CORS 控制，不是身份认证；首版没有内置用户或权限系统，部署入口归反向代理。

运行配置与代理示例见 [根 README](../../../README.md#部署)，契约证据在 packages/server/test/。
