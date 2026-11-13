# @h5-log/sdk

为测试环境 H5 采集 console、JavaScript 异常、接口记录和显式业务日志。不依赖 Vue；Axios 接入需要业务项目已有 Axios 1.7+。

## 安装与初始化

在本仓库运行 `npm run pack:sdk`，再在 H5 项目安装生成的包：

```sh
npm install E:/github/h5Log/h5-log-sdk-0.1.0.tgz
```

新增独立的 `src/app/remoteLog.ts`：

```ts
import { createLogger } from "@h5-log/sdk";

export const remoteLogger = createLogger({
  enabled:
    import.meta.env.MODE === "test" &&
    import.meta.env.VITE_ENABLE_REMOTE_LOG === "true",
  appId: "26",
  environment: import.meta.env.MODE,
  endpoint: import.meta.env.VITE_LOG_ENDPOINT,
  deviceName: "26 测试手机",
  captureFetch: false,
  // 合批间隔：默认 250ms，越小越即时、请求数越多（最小 50ms）
  flushIntervalMs: 250,
});
```

在 `.env.test` 中配置：

```dotenv
VITE_ENABLE_REMOTE_LOG=true
VITE_LOG_ENDPOINT=https://你的日志域名/api/logs
```

在应用入口尽早导入 `./app/remoteLog`。console 和全局异常会自动采集，业务中的 `console.log/info/warn/error/debug` 不需要逐处修改。生产环境保持关闭；未启用时 SDK 不改写 console，也不发起上传。

## 接口采集

### Axios

```ts
import { attachAxiosLogger } from "@h5-log/sdk/axios";
import { remoteLogger } from "@/app/remoteLog";

const detach = attachAxiosLogger(axiosClient, remoteLogger);
```

接入器包装实例的默认 adapter：请求在拦截器和请求转换后记录，响应在 Axios 响应转换和业务解包前记录；HTTP 错误也保留响应正文。请求、响应通过 `requestId` 对应。它不改变业务响应或错误，不使用业务请求通道上传日志。调用时单独指定 `adapter` 的请求首版不采集；更换默认 adapter 后需重新挂载。

### Fetch

在初始化时设置 `captureFetch: true`，SDK 会包装全局 `fetch`，记录请求参数、文本/JSON 响应和 HTTP 失败。`Request` 自带的流式正文不会克隆或读取，避免上传流被 tee 后在后台持续缓冲；需要采集普通文本/JSON 请求体时，显式传入有限大小的 `init.body`。二进制、SSE 和 ReadableStream 响应不读取正文。上传通道使用原生 fetch，不会被自身采集。

## 桥接与业务日志

已有 console 桥接日志会随 console 自动上传。需要单独标为 Bridge 时，在桥接收发边界调用：

```ts
remoteLogger.record("bridge", "info", {
  direction: "send",
  payload: originalMessage,
});
```

原生动作名、宿主对象和报文字段仍归业务包维护。若原有 console 已写出同一报文，选择其中一种记录方式，避免重复。SDK 记录调用时快照，不会恢复业务代码已经摘要或截断的内容；26 包接入时可以调整原有的长字符串摘要。

## 生命周期与故障

- `remoteLogger.context`：当前应用、客户端和页面会话信息。
- `await remoteLogger.flush()`：尝试发送当前一批日志；退避期间不强制重试，上传异常不向业务抛出。
- `remoteLogger.getStatus()`：读取是否启用、队列长度、已发送数量、丢弃数量、最近错误、退避时间和当前状态。
- `remoteLogger.stop()`：移除 console、全局异常、fetch 监听和定时器，取消上传并清空待发送队列。需要尝试发送剩余日志时先调用 `flush()`。
- `detach()`：恢复 Axios 原默认 adapter；停止采集时同时调用。

一个页面同时保留一个启用的采集器；重复初始化会停止旧采集器。客户端随机 ID 按应用保存在当前来源的 localStorage 中，localStorage 不可用时仅保证本次运行可用。

SDK 的资源限制、服务端 12 小时内存保留及部署方法见[项目说明](../../README.md#日志规则)。
