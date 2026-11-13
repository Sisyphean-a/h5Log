# SDK

scope: package:sdk
context: [remote-logging](../../requirements/contexts/remote-logging.md)

## 边界

@h5-log/sdk 是独立浏览器 ESM 包，不依赖 Vue，不包含 26 或其他 H5 的原生协议。业务包负责 appId、环境、测试开关和已有 Axios 实例；普通日志与接口两部分的采集边界见[远程日志](../../requirements/contexts/remote-logging.md)。

## 入口与契约

- src/index.ts：createLogger、console/异常监听、快照队列、独立 fetch 上传及停止恢复；创建采集器不等待日志服务器。默认每 250 毫秒合批发送至多 50 条，`flushIntervalMs` 可调（夹在 50–10000 毫秒），页面隐藏、pagehide、重新联网时立即发送。
- src/axios.ts：可选入口 @h5-log/sdk/axios，包装默认 adapter，在业务响应解包前采集；保持原响应与原错误。每次安装使用独立请求 ID 命名空间。
- src/fetch.ts：通过 captureFetch 显式启用，文本或 JSON 响应克隆有限读取；二进制、事件流和请求流不读取正文，也不克隆 Request 正文，避免 tee 分支无限缓冲。上传始终使用包装前的 fetch，避免自身采集；每次安装使用独立请求 ID 命名空间。
- src/types.ts：日志事件、客户端、存储记录、查询页类型和上下文字段上限的唯一契约；SDK 初始化与服务端校验共同使用。请求关联标识单独保留，正文截断后仍可关联。
- src/serialize.ts：对象快照、循环引用与资源限制；值、字段名、URLSearchParams 和 FormData 共享预算，超限标记必须可见。
- SDK 不把已有 console 摘要还原为原报文。调用级 adapter 不经默认 adapter，首版明确不覆盖。
- createLogger、LoggerOptions、Logger 与接口接入器的 JSDoc 随构建保留在 dist/*.js 和 dist/*.d.ts，作为目标项目直接阅读 SDK 时的接入说明。

使用方法见 [SDK README](../../../packages/sdk/README.md)，契约证据在 packages/sdk/test/。
