# @h5-log/sdk

测试环境 H5 的远程日志 SDK，不依赖 Vue。接入只有两部分：普通日志使用已有 `console`，接口按项目使用的 Axios 或 Fetch 开启采集。全局异常默认自动采集。

桥接输出也是普通 console 日志，不需要单独接入、分类或修改桥接收发代码。

## 1. 初始化：只需 3 项配置

在 SDK 仓库运行 `npm run pack:sdk`，将新生成的 `h5-log-sdk-0.1.1.tgz` 复制到目标 H5 项目后安装：

```sh
npm install ./h5-log-sdk-0.1.1.tgz
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

采集器包装默认 adapter，在请求转换后、响应转换及业务解包前记录参数和正文；HTTP 错误也保留响应正文，以 `requestId` 关联收发，保持原响应和错误。采集关闭或状态读取失败时直接透传原 adapter，不读取诊断元信息或额外解析正文；请求途中停止采集后，也不再预处理响应。日志上传使用 SDK 独立通道。单次请求自定义 `adapter` 不采集；更换默认 adapter 后需重新挂载。

接入前可用 `node -e "console.log(require('axios/package.json').version)"` 检查版本；低于 1.7 时不要挂载，此接入器依赖 Axios 根导出的 `getAdapter`。

### Fetch：初始化加一个开关

使用原生 Fetch 请求时，在初始化选项中增加 `captureFetch: true`，无需改写业务请求。默认关闭，不使用 Fetch 时无需配置。

文本/JSON 响应克隆后有限读取，不阻塞业务读取原响应。`Request` 自带的流式正文不克隆或读取；需要采集普通请求体时通过 `init.body` 传入文本或 JSON 字符串。二进制、SSE 与请求流不读取正文。FormData 和 URLSearchParams 沿用快照预算逐项采集，按 `{ name, value }` 有序条目保留重复字段；超限有可见标记，不先构造完整数组或编码字符串，不改动原请求正文。文件只采集元信息。SDK 上传不会被自身递归采集。

## 通常不需要配置的选项

| 选项 | 默认值与用途 |
| --- | --- |
| `environment` | `"test"`；区分多个测试环境时再设置实际环境名 |
| `deviceId` | 默认使用浏览器本地标识；宿主有稳定设备 ID 时显式传入，例如 URL 中的 `googleGaid` |
| `deviceName` | 空；可传入设备型号，同型号的不同设备由工作台添加 `-1`、`-2`、`-3` 区分 |
| `captureConsole` | `true`；自动采集已有 console 输出 |
| `captureErrors` | `true`；自动采集全局错误与未处理的 Promise 拒绝 |
| `captureFetch` | `false`；使用 Fetch 时开启 |
| `flushIntervalMs` | `500`；合批间隔，限制在 50–10000ms，通常保持默认 |

测试宿主可用 `deviceId` 固定设备身份，`deviceName` 只传型号。当前十个包使用 `gaid:<googleGaid>`；缺少 GAID 时使用 `model:<归一化设备型号>`，不读写旧的随机设备存储。刷新或清除存储后，只要身份来源相同仍归为同一设备；后续获得 GAID 会按约定切换为新设备。页面会话仍重新生成。工作台保留应用和环境的区分，同一设备跨应用使用同一型号编号；编号按当前保留目录的首次出现顺序生成，在最近上报排序变化时保持不变。

SDK 记录调用时的对象快照；业务代码已经摘要或截断的内容无法恢复。对象及 Error 自有或继承的访问器不会被调用，以 `[Getter]` 标记；普通 Error 保留类型、消息、安全堆栈和 cause，惰性堆栈依赖自定义访问器或被替换的格式化钩子时不展开。日常输出继续使用 console，底层 `record()` 不是普通日志接入的必需步骤。

## 生命周期与故障

- `remoteLogger.context`：只读应用、设备和当前页面会话信息。
- `remoteLogger.getStatus()`：读取独立的本地状态快照，不依赖日志上传；字段和测试环境读取入口见下方“本地诊断”。配置无效时采集器会禁用，原因在 `lastError` 中。
- `await remoteLogger.flush()`：尝试发送当前一批；退避期间不强制重试，失败不向业务抛出，不保证清空全部队列。
- `remoteLogger.stop()`：恢复 console、Fetch 与异常监听，清除定时器，取消上传并清空队列；需要尝试发送剩余日志时先调用 `flush()`。
- Axios 挂载独立管理；停止采集时同时调用返回的 `detach()` 和 `remoteLogger.stop()`。

一个页面只保留一个启用的采集器，重复初始化会停止旧采集器；旧的 Axios 挂载需要解绑并为新采集器重新挂载。设备随机 ID 按应用保存在当前来源的 localStorage 中，存储不可用时仅保证本次运行可用。

队列最多 1,000 条 / 4 MiB，每批最多 50 条；压缩与上传整体限时 5 秒，取消信号即使未被底层请求响应，也会释放发送锁并保留批次重试。网络、超时、压缩失败及 HTTP 5xx / 429 按 1 → 2 → 4 → 8 → 16 → 30 秒退避，达到上限后继续每约 30 秒尝试，不设重试次数上限；实际时机仍依赖 JS 调度，容量淘汰或页面销毁仍可能丢失日志。除 429 外的 HTTP 4xx 属于上传被拒绝，该批次计入 dropped 并在 lastError 中报告，不无限重传；重新联网、恢复可见或 pageshow 时取消旧上传并立即重试。单条日志最多 128 KiB，快照最多展开 12 层、处理 2,000 个值并保留合计 64K 字符的字符串，超限会留下可见标记。页面退出、WebView 被终止或服务不可达时允许丢失，不提供持久化补发。

### 本地诊断（不依赖上传）

**SDK 不会自动创建 `window.__H5_LOG_STATUS__`。更新 SDK、在宿主挂接入口、重新发布测试 H5 是三个必要步骤；只更新 SDK 或日志服务不够。** 已经打开的旧页面无法自动获得新代码，更新页面会丢失当前内存队列和诊断状态，应先保存仍可取得的现场信息。

#### 1. 更新目标应用实际安装的 SDK

按上方“初始化”重新打包、复制并安装新的 tgz。即使文件仍叫 `h5-log-sdk-0.1.0.tgz`，也必须重新安装，不能仅覆盖包文件；工作区项目需要更新实际接入 SDK 的应用依赖。保留原来的 `createLogger()` 和 Axios/Fetch 接入，不要为了诊断再创建一个采集器，否则会停止原采集器。

#### 2. 在现有初始化模块添加测试入口

在 `src/app/remoteLog.ts` 的 `remoteLogger` 创建之后、热更新清理代码之前添加。下面兼容“禁用时不创建实例”的接入方式，不需要修改各个业务页面：

```ts
if (import.meta.env.MODE === "test" && remoteLogger) {
  const logger = remoteLogger;
  Object.defineProperty(window, "__H5_LOG_STATUS__", {
    configurable: true,
    value: () => logger.getStatus(),
  });
}
```

入口只读取状态，不提供 `flush()`、`stop()` 等控制能力；只在测试构建安装，生产不要安装，也不要把整个 logger 暴露到全局。

#### 3. 发布后先确认入口和 SDK 版本

按宿主项目原有方式构建、发布 **test 模式的 H5**，手机手动加载新版本。不要等到下一次故障才检查：在手机 vConsole 的命令输入框执行：

```js
typeof window.__H5_LOG_STATUS__
```

应返回 `"function"`。再执行下方读取命令，输出应具有 `lastTickAt`、`phase`、`lastFailure` 等字段。若缺少新字段，说明宿主仍使用旧 SDK，检查实际安装的包及手机加载的构建。

#### 4. 故障时保留现场，手动采集两份快照

不要先刷新、杀 App、重新初始化或调用 `flush()` / `stop()`。在 vConsole 执行并复制返回的 JSON 文本：

```js
typeof window.__H5_LOG_STATUS__ === "function"
  ? JSON.stringify(window.__H5_LOG_STATUS__())
  : "未安装诊断入口"
```

间隔 5–10 秒，**手动**再执行一次，并附上故障时间及当时是否切换过前后台。不要用 `setTimeout()` 自动获取第二份，因为定时调度本身也是待检查对象。vConsole 中仍有 console/桥接输出，只能说明本地产生日志，不能证明已上传。

如果返回 `"未安装诊断入口"` 或入口类型为 `"undefined"`，先检查宿主是否添加上述代码、日志开关与 test 模式是否匹配、初始化模块是否被应用入口导入，以及手机是否加载了新构建；不是靠重新运行读取命令解决。

#### 状态字段与判断

`getStatus()` 保留 `enabled`、`queued`、`dropped`、`sent`、`lastSentAt`、`lastError`、`retryAt` 和 `state`，新增以下诊断字段。所有时间均为 Unix 毫秒，尚无对应动作时为 `null`。

| 字段 | 含义 |
| --- | --- |
| `recorded` / `lastRecordedAt` | 累计成功入队数及最近事件的采集时间；数量包含随后被容量淘汰的日志，不包含采集失败或停用后的调用 |
| `lastTickAt` | 现有上传定时器最近执行时间；即使队列为空也更新 |
| `inFlightCount` | 当前批次持有的条数，已不包含在 `queued` 中 |
| `lastAttemptAt` | 最近一次批次处理开始时间，包含压缩阶段 |
| `phase` | `idle`、`compressing` 或 `uploading`；退避或等待下次定时回调时也为 `idle`，不代表队列为空 |
| `lastHttpStatus` | 最近收到的 HTTP 状态；后续网络失败不会覆盖它，不能单独据此判断当前上传成功 |
| `lastFailure` | 最近一次失败 `{ at, stage, message, httpStatus }`；无失败时为 `null`，恢复成功后仍保留 |

`lastFailure.stage` 为 `initialization`、`capture`、`compression`、`network` 或 `http`；非 HTTP 失败的 `httpStatus` 为 `null`。成功上传清除 `lastError`，但保留 `lastFailure`，便于恢复后查看最近异常。修改返回的对象不会修改 SDK 内部状态。

诊断只保留一份内存状态和最近失败的元数据，不保存业务正文、不增加定时器、存储写入或网络请求；页面重建后重置。

| 观察 | 如何判断 |
| --- | --- |
| 有新的可采集 console/接口事件，但 `recorded` 不增长 | 检查 `enabled`、采集器是否被替换或停止、接口是否仍走已挂接的实例；单纯空闲时不增长是正常现象 |
| `recorded` 增长，但 `lastTickAt` 长时间不更新 | 支持检查 JS 定时调度；同时核对是否切到后台或原生页面，不直接宣称 WebView 已冻结 |
| `inFlightCount > 0` | 结合 `phase` 和 `lastAttemptAt` 检查压缩或请求停留阶段；这部分条数不在 `queued` 中 |
| `state === "retrying"` 且 `phase === "idle"` | 上次尝试失败，正在等待 `retryAt`；不是停止采集，也不是上传锁仍被占用 |
| `lastFailure.stage === "network"` 且消息为 `Failed to fetch` | fetch 未取得可用响应；网络连接和浏览器请求策略等均可能导致，不能单凭此消息确定 TLS、CORS 或具体接口是否已到达服务端 |
| `lastHttpStatus === 202`，同时有更新的网络失败 | 202 是历史响应，不能据此认为当前上传成功 |

例如 `recorded: 109`、`sent: 96`、`queued: 13`、`dropped: 0`、`inFlightCount: 0`、`state: "retrying"` 表示采集过 109 条，其中 13 条仍在队列中等待重试，并非达到条数上限。`sent` 表示相应批次收到成功 HTTP 响应，不是逐条入库确认；实际入库仍需服务端证据。

若现场显示网络阶段失败，可先在同一个故障页面读取日志服务健康接口。将下面地址替换为实际地址，并保留部署子路径，例如 `/h5-log/api/health`：

```js
fetch("https://logs.example.com/api/health", {
  credentials: "omit", cache: "no-store", keepalive: false,
})
  .then(r => console.log("H5_LOG_HEALTH", r.status))
  .catch(e => console.error("H5_LOG_HEALTH", String(e)));
```

健康 GET 也失败时检查该页面到日志域名的连接；GET 成功仅说明该请求可达，不能证明日志 POST、压缩请求或 keepalive 行为正常。这些均为定位线索，不单凭一张快照宣布真实断联已修复。

## 宿主开销与传输

业务请求不等待日志上传，不代表 SDK 没有主线程开销：调用时的快照与 JSON 序列化仍是同步的，以保留当时的对象值。高频、大对象或长文本日志可能挤占帧预算；不要在逐帧回调或密集循环中反复输出大型对象。既有快照、队列和正文限制保持不变，不因网络优化而采样或额外删减内容。

空队列不发送请求，默认每 500ms 尝试合批上传。批次达到 8 KiB 且宿主支持 `CompressionStream` 时，使用原生异步 gzip 压缩，仅在体积变小时发送压缩内容；小批次或没有该能力的宿主发送普通 JSON，不加载压缩库。压缩失败会在 `getStatus().lastError` 中报告并保留批次重试，不抛给业务代码，也不伪装为成功。压缩仍有 CPU、内存和电量成本，真机流畅度需要在目标 WebView 上验证。

日志上传使用普通 fetch，不开启 `keepalive`，避免常规上报受到其浏览器共享额度限制；单个请求小于限制并不保证共享额度可用。`keepalive` 是页面退出后的请求存活选项，不是 HTTP 长连接开关。浏览器可能在发出 HTTP 请求前拒绝 fetch，因此服务端看不到请求并不等于 SDK 没有尝试，应对比 `lastAttemptAt` 和 `lastFailure`。不在失败后偷偷切换传输或丢弃批次，仍使用上述明确的失败退避规则。

页面隐藏、pagehide 或手动 `flush()` 也使用普通 fetch 尽力发送；不承诺文档销毁后请求继续存活。更新到此修复需重新安装 SDK 并发布宿主构建；旧页面的内存队列无法随更新恢复，应先保存现场。

### 原生页面覆盖 WebView

内存队列与定时上传依赖 WebView 的 JS 调度。Android 原生页面覆盖后，visibilitychange/pagehide 不一定触发；即使触发，上传也不保证在暂停前完成。5 秒超时与重试同样需要 JS 恢复调度，不能在冻结期间替代原生执行。仅凭服务端缺少响应日志，不能确认该日志已经入队；应同时核对 logger.getStatus()、采集器是否仍启用，以及原生的 WebView 生命周期。

原生跳转前可调用 `void remoteLogger.flush()` 尝试提前发送，但不要等待上传结果再推进业务。空闲且无需异步压缩时，请求在 flush 返回前发起；已有上传、退避、大批次异步压缩或多批积压时仍不保证本次新日志已发出。页面文档被替换会丢失内存队列，新文档须重新初始化。若必须在 WebView 暂停或销毁期间继续送达，需要宿主原生承担上传或持有队列，而不是依赖更短的 JS 定时器。

**升级顺序：先部署支持 gzip 的日志服务，再更新本包并重新构建宿主 H5。** 上传使用 `Content-Encoding: gzip`，跨域预检须允许该头；旧服务端不支持此编码，不能只升级 SDK。网络与生命周期恢复只帮助重试，不保证 WebView 被终止后补发。

`createLogger`、`LoggerOptions`、`Logger` 和接口接入器的说明及默认值随包保留在 `dist/*.js` 与 `dist/*.d.ts` 中，可直接阅读 SDK 或使用编辑器类型提示，无需先查阅此文档。
