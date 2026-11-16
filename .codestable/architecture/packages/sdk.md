# SDK

scope: package:sdk
context: [remote-logging](../../requirements/contexts/remote-logging.md)

## 边界

@h5-log/sdk 是独立浏览器 ESM 包，不依赖 Vue，不包含 26 或其他 H5 的原生协议。业务包负责 appId、环境、测试开关和已有 Axios 实例；普通日志与接口两部分的采集边界见[远程日志](../../requirements/contexts/remote-logging.md)。

## 入口与契约

- src/index.ts：createLogger、console/异常监听、快照队列、独立 fetch 上传及停止恢复；创建采集器不等待日志服务器。默认每 500 毫秒合批发送至多 50 条，`flushIntervalMs` 可调（夹在 50–10000 毫秒），空队列不请求；页面隐藏或 pagehide 时尝试发送，重新联网、可见与 pageshow 时取消旧上传并跳过退避重试。压缩与上传共用 5 秒限时，独立取消 Promise 释放发送锁，不依赖 fetch 响应 AbortSignal；网络、超时或压缩失败保留批次并显式报告，除 429 外的 4xx 拒绝计入 dropped。批次达到 8 KiB 且具备 CompressionStream 时原生异步 gzip，仅体积变小时编码发送；能力不存在时直接 JSON，压缩失败不静默降级。先部署支持 gzip 的 app，再更新宿主 SDK。空闲且不需异步压缩时 flush 在返回前直接调用 fetch，内部异步函数承接同步异常，避免提前清理后遗留发送锁。定时上传、超时和重试均依赖 JS 调度；原生覆盖暂停 WebView、未触发生命周期事件或替换文档时不保证送达。冻结期间继续上传属于宿主原生责任，SDK 不引入业务桥接协议或持久化队列。
- src/axios.ts：可选入口 @h5-log/sdk/axios，包装默认 adapter，在业务响应解包前采集；保持原响应与原错误。禁用或状态读取异常时直接透传，不访问诊断元信息或解析正文；响应及错误预处理前再次检查启用状态，避免请求途中停用后继续产生采集开销。每次安装使用独立请求 ID 命名空间。
- src/fetch.ts：通过 captureFetch 显式启用，文本或 JSON 响应克隆有限读取；二进制、事件流和请求流不读取正文，也不克隆 Request 正文，避免 tee 分支无限缓冲。FormData 和 URLSearchParams 请求正文直接复用 snapshot 的逐项预算，不先无界 Array.from 或 toString；有序条目保留重复名称和文件元信息，不改动业务正文。上传始终使用包装前的 fetch，避免自身采集；每次安装使用独立请求 ID 命名空间。
- src/types.ts：日志事件、客户端、存储记录、查询页类型和上下文字段上限的唯一契约；SDK 初始化与服务端校验共同使用。请求关联标识单独保留，正文截断后仍可关联。
- src/serialize.ts：对象快照、循环引用与资源限制；值、字段名、URLSearchParams 和 FormData 共享预算，超限标记必须可见。Error 字段通过自有及原型链描述符读取，访问器标记为 [Getter]；仅当名称、消息是数据字符串且格式化钩子安全时读取原生惰性堆栈，避免间接执行访问器，普通堆栈和 cause 保留。快照和 JSON 序列化同步保留调用时值，不能为了异步化改变其时点；独立上传不等于宿主零开销，高频大对象仍可能挤占帧预算。
- 本地诊断不依赖可能已中断的上传链路：getStatus() 提供采集进度、现有定时器心跳、在途批次及阶段，并在恢复后保留最近失败的元数据，供宿主区分调度、压缩、网络与 HTTP 问题；不保存业务正文、不新增定时器或存储/网络 IO，也不自动挂载全局入口。调用者按需在测试环境开放只读入口；诊断线索不等于真机断联根因已确认。
- 上传统一使用普通 fetch，不开启 keepalive：普通合批不依赖页面退出后存活机制的共享请求额度，仅判断单批大小不能保证可用。页面隐藏及退出仍只尽力 flush，不承诺文档销毁后继续送达；网络等可重试失败保留有界队列，退避封顶后继续尝试，不按次数终止或静默切换传输。真机对照已证实开启 keepalive 时的失败差异，不据此声称具体额度耗尽机制已得到证明。
- SDK 不把已有 console 摘要还原为原报文。调用级 adapter 不经默认 adapter，首版明确不覆盖。
- createLogger、LoggerOptions、Logger 与接口接入器的 JSDoc 随构建保留在 dist/*.js 和 dist/*.d.ts，作为目标项目直接阅读 SDK 时的接入说明。

使用方法见 [SDK README](../../../packages/sdk/README.md)，契约证据在 packages/sdk/test/。
