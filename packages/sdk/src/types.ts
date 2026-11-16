export type LogLevel = "debug" | "info" | "log" | "warn" | "error";
/** 日志来源；桥接、业务等普通输出统一通过 console 采集，不单独分类或接入。 */
export type LogSource = "console" | "error" | "http" | "custom";
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface LogContext {
  appId: string;
  environment: string;
  deviceId: string;
  sessionId: string;
  deviceName: string;
  userAgent: string;
}
export interface LogEvent extends LogContext {
  eventId: string;
  timestamp: number;
  pageUrl: string;
  level: LogLevel;
  source: LogSource;
  args: JsonValue[];
  requestId?: string;
}
export interface StoredLog extends LogEvent {
  id: number;
  receivedAt: number;
  clientKey: string;
}
export interface LogClient extends LogContext {
  key: string;
  lastSeen: number;
  logCount: number;
  errorCount: number;
}
export interface LogSession {
  clientKey: string;
  sessionId: string;
  firstSeen: number;
  lastSeen: number;
  logCount: number;
  errorCount: number;
  pageUrl: string;
}
export interface LogPage {
  logs: StoredLog[];
  clients: LogClient[];
  sessions: LogSession[];
  cursor: number;
  hasMore: boolean;
  total: number;
  retentionHours: number;
  serverId: string;
}
export interface LogDetail {
  log: StoredLog;
  related: StoredLog[];
}
export interface ClientUpdate {
  clients: LogClient[];
  expiresBefore: number;
  evictedThroughId: number;
}
export interface ServiceStatus {
  status: "ok";
  serverId: string;
  startedAt: number;
  now: number;
  uptimeSeconds: number;
  logs: number;
  bytes: number;
  clients: number;
  sessions: number;
  received: number;
  evicted: number;
  subscribers: number;
  retentionHours: number;
  limits: {
    maxLogs: number;
    maxBytes: number;
    maxSubscribers: number;
    maxEventBytes: number;
  };
}
/** 最近一次失败的元数据；恢复成功后仍保留，不包含日志正文。 */
export interface LoggerFailure {
  at: number;
  stage: "initialization" | "capture" | "compression" | "network" | "http";
  message: string;
  httpStatus: number | null;
}
export interface LoggerStatus {
  enabled: boolean;
  queued: number;
  dropped: number;
  lastError: string | null;
  sent: number;
  lastSentAt: number | null;
  retryAt: number | null;
  state: "disabled" | "idle" | "sending" | "retrying";
  /** 累计成功入队数，包含随后被容量淘汰的日志；停用后的调用不计入。 */
  recorded: number;
  /** 最近成功入队事件的采集时间，Unix 毫秒；尚无事件时为 null。 */
  lastRecordedAt: number | null;
  /** 现有上传定时器最近回调时间，Unix 毫秒；尚未执行时为 null。 */
  lastTickAt: number | null;
  /** 已移出待上传队列、当前批次持有的条数，不包含在 queued 中。 */
  inFlightCount: number;
  /** 最近一次批次处理（含压缩）开始时间，Unix 毫秒。 */
  lastAttemptAt: number | null;
  /** idle 不代表队列为空；退避或尚未到上传时机时也为 idle。 */
  phase: "idle" | "compressing" | "uploading";
  /** 最近收到的 HTTP 状态；后续网络失败不会覆盖它。 */
  lastHttpStatus: number | null;
  /** 最近失败的独立副本；成功只清空 lastError，不清除此历史。 */
  lastFailure: LoggerFailure | null;
}
/** 采集器。日常日志直接使用 console；接口使用 Axios 接入器或 captureFetch。 */
export interface Logger {
  /** 应用、环境、设备和本次页面会话的只读上下文，设备与会话标识自动生成。 */
  readonly context: Readonly<LogContext>;
  /** 底层记录入口，供采集器或显式自定义记录使用；普通日志无需改为调用此方法。 */
  record(source: LogSource, level: LogLevel, ...args: unknown[]): void;
  /** 尝试上传一批；空闲且无需异步压缩时立即发起请求。退避期间不强制重试，不保证清空整个队列或在 WebView 暂停前送达；失败不向业务抛出。 */
  flush(): Promise<void>;
  /** 恢复 console、Fetch 和异常监听，取消上传并清空队列；Axios 另调用挂载返回的 detach。 */
  stop(): void;
  /** 读取独立状态快照，不触发上传、定时任务或存储 IO；配置无效时在 lastError 中说明原因。 */
  getStatus(): LoggerStatus;
}
/** 初始化仅需 enabled、appId、endpoint；其他选项保留默认即可。 */
export interface LoggerOptions {
  /** 必填：只有 true 才启用；由接入项目判断测试环境，生产必须为 false。 */
  enabled: boolean;
  /** 必填：应用标识，1–128 字符；同一应用保持稳定，用于区分客户端。 */
  appId: string;
  /** 必填：日志服务的 HTTP(S) /api/logs 地址，可为相对路径；HTTPS 页面使用 HTTPS 地址。 */
  endpoint: string;
  /** 默认 "test"；接入多个测试环境时设置实际环境名，最多 64 字符。 */
  environment?: string;
  /** 可选显示名称，默认空；设备标识自动生成，无需手动传入，最多 128 字符。 */
  deviceName?: string;
  /** 默认 true：自动采集 console.log/info/warn/error/debug，包括已有桥接和业务输出。 */
  captureConsole?: boolean;
  /** 默认 true：自动采集全局 error 和 unhandledrejection，无需另行接入。 */
  captureErrors?: boolean;
  /** 默认 false：使用原生 Fetch 请求时设为 true；Axios 实例另用 attachAxiosLogger 挂载。 */
  captureFetch?: boolean;
  /** 默认 500ms；有效值四舍五入并限制为 50–10000ms，通常无需配置。 */
  flushIntervalMs?: number;
}
export const CONTEXT_LIMITS: Readonly<Record<keyof LogContext, number>> =
  Object.freeze({
    appId: 128,
    environment: 64,
    deviceId: 256,
    sessionId: 256,
    deviceName: 128,
    userAgent: 1024,
  });
export const MAX_EVENT_BYTES = 128 * 1024;
export const MAX_BATCH_BYTES = 512 * 1024;
export const MAX_BATCH_EVENTS = 50;
