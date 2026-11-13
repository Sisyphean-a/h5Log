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
export interface LoggerStatus {
  enabled: boolean;
  queued: number;
  dropped: number;
  lastError: string | null;
  sent: number;
  lastSentAt: number | null;
  retryAt: number | null;
  state: "disabled" | "idle" | "sending" | "retrying";
}
/** 采集器。日常日志直接使用 console；接口使用 Axios 接入器或 captureFetch。 */
export interface Logger {
  /** 应用、环境、设备和本次页面会话的只读上下文，设备与会话标识自动生成。 */
  readonly context: Readonly<LogContext>;
  /** 底层记录入口，供采集器或显式自定义记录使用；普通日志无需改为调用此方法。 */
  record(source: LogSource, level: LogLevel, ...args: unknown[]): void;
  /** 尝试上传一批；退避期间不强制重试，失败不向业务抛出，不保证清空整个队列。 */
  flush(): Promise<void>;
  /** 恢复 console、Fetch 和异常监听，取消上传并清空队列；Axios 另调用挂载返回的 detach。 */
  stop(): void;
  /** 查看启用状态、队列、发送/丢弃数量及错误；配置无效时禁用并在 lastError 中说明原因。 */
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
  /** 默认 250ms；有效值四舍五入并限制为 50–10000ms，通常无需配置。 */
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
