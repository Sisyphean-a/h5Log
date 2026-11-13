# @h5-log/sdk

测试环境 H5 的远程日志 SDK，不依赖 Vue。接入只有两部分：普通日志使用已有 `console`，接口按项目使用的 Axios 或 Fetch 开启采集。全局异常默认自动采集。

桥接输出也是普通 console 日志，不需要单独接入、分类或修改桥接收发代码。

## 1. 初始化：只需 3 项配置

在 SDK 仓库运行 `npm run pack:sdk`，将新生成的 `h5-log-sdk-0.1.0.tgz` 复制到目标 H5 项目后安装：

```sh
npm install ./h5-log-sdk-0.1.0.tgz
```

新增 `src/app/remoteLog.ts`（以下以 Vite 为例）：

```ts
import { createLogger } from "@h5-log/sdk";

export const remoteLogger = createLogger({
  enabled: import.meta.env.MODE === "test",
  appId: "your-h5",
  endpoint: import.meta.env.VITE_LOG_ENDPOINT,
});
```

在 `.env.test` 配置可从手机访问的日志服务地址：

```dotenv
VITE_LOG_ENDPOINT=https://你的日志域名/api/logs
```

在应用入口尽早导入 `./app/remoteLog`。已有 `console.log/info/warn/error/debug`（包含桥接和业务日志）、全局 JavaScript 错误及未处理的 Promise 拒绝自动采集，不需要逐处修改。

`enabled` 由项目显式判断，生产必须为 `false`；SDK 不自行识别构建环境。未启用时不改写 console 或 Fetch，也不上传日志。HTTPS 页面应配置 HTTPS 日志地址。

## 2. 接口：按实际请求方式接入

### Axios：已有实例挂载一行

需要业务项目已有 Axios 1.7+。在创建业务 Axios 实例后、发起请求前挂载：

```ts
import { attachAxiosLogger } from "@h5-log/sdk/axios";
import { remoteLogger } from "@/app/remoteLog";

const detach = attachAxiosLogger(axiosClient, remoteLogger);
```

复用原实例，不为日志创建新实例，也不修改各处请求。多个 `axios.create()` 实例分别挂载一次；同一实例重复挂载会替换上次安装。

采集器包装默认 adapter，在请求转换后、响应转换及业务解包前记录参数和正文；HTTP 错误也保留响应正文，以 `requestId` 关联收发，保持原响应和错误。日志上传使用 SDK 独立通道。单次请求自定义 `adapter` 不采集；更换默认 adapter 后需重新挂载。

接入前可用 `node -e "console.log(require('axios/package.json').version)"` 检查版本；低于 1.7 时不要挂载，此接入器依赖 Axios 根导出的 `getAdapter`。

### Fetch：初始化加一个开关

使用原生 Fetch 请求时，在初始化选项中增加 `captureFetch: true`，无需改写业务请求。默认关闭，不使用 Fetch 时无需配置。

文本/JSON 响应克隆后有限读取，不阻塞业务读取原响应。`Request` 自带的流式正文不克隆或读取；需要采集普通请求体时通过 `init.body` 传入文本或 JSON 字符串。二进制、SSE 与请求流不读取正文。SDK 上传不会被自身递归采集。

## 通常不需要配置的选项

| 选项 | 默认值与用途 |
| --- | --- |
| `environment` | `"test"`；区分多个测试环境时再设置实际环境名 |
| `deviceName` | 空；需要自定义工作台显示名称时设置，设备和会话标识自动生成 |
| `captureConsole` | `true`；自动采集已有 console 输出 |
| `captureErrors` | `true`；自动采集全局错误与未处理的 Promise 拒绝 |
| `captureFetch` | `false`；使用 Fetch 时开启 |
| `flushIntervalMs` | `250`；合批间隔，限制在 50–10000ms，通常保持默认 |

SDK 记录调用时的对象快照；业务代码已经摘要或截断的内容无法恢复。日常输出继续使用 console，底层 `record()` 不是普通日志接入的必需步骤。

## 生命周期与故障

- `remoteLogger.context`：只读应用、设备和当前页面会话信息。
- `remoteLogger.getStatus()`：查看启用状态、队列、发送/丢弃数量、最近错误及退避状态。配置无效时采集器会禁用，原因在 `lastError` 中。
- `await remoteLogger.flush()`：尝试发送当前一批；退避期间不强制重试，失败不向业务抛出，不保证清空全部队列。
- `remoteLogger.stop()`：恢复 console、Fetch 与异常监听，清除定时器，取消上传并清空队列；需要尝试发送剩余日志时先调用 `flush()`。
- Axios 挂载独立管理；停止采集时同时调用返回的 `detach()` 和 `remoteLogger.stop()`。

一个页面只保留一个启用的采集器，重复初始化会停止旧采集器；旧的 Axios 挂载需要解绑并为新采集器重新挂载。设备随机 ID 按应用保存在当前来源的 localStorage 中，存储不可用时仅保证本次运行可用。

队列最多 1,000 条 / 4 MiB，每批最多 50 条；上传失败按 1–30 秒退避，网络恢复后立即尝试。单条日志最多 128 KiB，快照最多展开 12 层、处理 2,000 个值并保留合计 64K 字符的字符串，超限会留下可见标记。页面退出、WebView 被终止或服务不可达时允许丢失，不提供持久化补发。

`createLogger`、`LoggerOptions`、`Logger` 和接口接入器的说明及默认值随包保留在 `dist/*.js` 与 `dist/*.d.ts` 中，可直接阅读 SDK 或使用编辑器类型提示，无需先查阅此文档。
