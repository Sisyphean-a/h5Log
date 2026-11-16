import { snapshot } from "./serialize.js";
import { attachFetchLogger } from "./fetch.js";
import {
  CONTEXT_LIMITS,
  MAX_BATCH_BYTES,
  MAX_BATCH_EVENTS,
  MAX_EVENT_BYTES,
} from "./types.js";
export { CONTEXT_LIMITS, MAX_BATCH_EVENTS, MAX_EVENT_BYTES } from "./types.js";
import type {
  JsonValue,
  LogContext,
  LogEvent,
  Logger,
  LoggerOptions,
  LoggerFailure,
  LoggerStatus,
  LogLevel,
  LogSource,
} from "./types.js";
export type * from "./types.js";

const MAX_QUEUE_EVENTS = 1000;
const MAX_QUEUE_BYTES = 4 * 1024 * 1024;
const DEFAULT_FLUSH_INTERVAL_MS = 500;
const MIN_FLUSH_INTERVAL_MS = 50;

/** Rule: 高频 console 与接口日志默认 500ms 合批；过小会放大请求数。 */
function flushInterval(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    return DEFAULT_FLUSH_INTERVAL_MS;
  return Math.min(10000, Math.max(MIN_FLUSH_INTERVAL_MS, Math.round(value)));
}
const levels: LogLevel[] = ["debug", "info", "log", "warn", "error"];
let currentLogger: Logger | undefined;

function randomId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
  );
}

function deviceId(appId: string): string {
  const key = `h5-log:device:${appId}`;
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const id = randomId();
    localStorage.setItem(key, id);
    return id;
  } catch {
    return randomId();
  }
}

/**
 * 创建测试环境日志采集器，仅需 enabled、appId、endpoint 三项配置。
 *
 * 启用后自动采集 console 和全局异常；桥接、业务输出继续使用原有 console，无需额外接入。
 * Axios 使用 @h5-log/sdk/axios 的 attachAxiosLogger；原生 Fetch 设置 captureFetch: true。
 * 设备和会话标识、快照、有限队列、合批及失败退避均由 SDK 管理，不阻塞业务等待上传。
 * 快照与 JSON 序列化仍是同步开销，高频大对象可能影响宿主帧率。
 * 大批次可原生异步 gzip 压缩，先更新日志服务再更新 SDK；原生暂停 WebView 时不保证上传完成。
 *
 * enabled 必须由接入项目显式判断，生产传 false；SDK 不自行识别构建环境。
 * 配置无效时禁用并通过 getStatus().lastError 说明；一个页面只保留一个启用的采集器。
 *
 * @example
 * const logger = createLogger({
 *   enabled: import.meta.env.MODE === "test",
 *   appId: "your-h5",
 *   endpoint: "https://logs.example.com/api/logs",
 * });
 * // 既有 console.log/info/warn/error/debug 自动采集，包括桥接输出。
 */
export function createLogger(options: LoggerOptions): Logger {
  let active = options.enabled === true && typeof window !== "undefined";
  let lastError: string | null = null;
  let lastFailure: LoggerFailure | null = null;
  function setFailure(stage: LoggerFailure["stage"], message: string, httpStatus: number | null = null): void {
    lastError = message;
    lastFailure = { at: Date.now(), stage, message, httpStatus };
  }
  let endpoint = "";
  const context: Readonly<LogContext> = Object.freeze({
    appId: options.appId,
    environment: options.environment ?? "test",
    deviceId: active ? deviceId(options.appId) : "",
    sessionId: active ? randomId() : "",
    deviceName: options.deviceName ?? "",
    userAgent: active ? navigator.userAgent : "",
  });
  let nativeFetch: typeof fetch | undefined;
  if (active) {
    try {
      const url = new URL(options.endpoint, window.location.href);
      if (
        !options.endpoint.trim() ||
        !["http:", "https:"].includes(url.protocol)
      ) {
        throw new Error("请配置有效的 HTTP(S) 日志地址");
      }
      for (const key of Object.keys(CONTEXT_LIMITS) as (keyof LogContext)[]) {
        const value = context[key];
        const required = key !== "deviceName" && key !== "userAgent";
        if (
          typeof value !== "string" ||
          value.length > CONTEXT_LIMITS[key] ||
          (required && value.length === 0)
        ) {
          throw new Error(
            `日志字段 ${key} 无效（${required ? "1" : "0"}–${CONTEXT_LIMITS[key]} 字符）`,
          );
        }
      }
      endpoint = url.href;
      currentLogger?.stop();
      nativeFetch = globalThis.fetch.bind(globalThis);
    } catch (error) {
      active = false;
      setFailure("initialization", error instanceof Error ? error.message : "日志初始化失败");
    }
  }

  const queue: { text: string; bytes: number }[] = [];
  let queueBytes = 0;
  let sequence = 0;
  let dropped = 0;
  let sent = 0;
  let lastSentAt: number | null = null;
  let recorded = 0;
  let lastRecordedAt: number | null = null;
  let lastTickAt: number | null = null;
  let inFlightCount = 0;
  let lastAttemptAt: number | null = null;
  let phase: LoggerStatus["phase"] = "idle";
  let lastHttpStatus: number | null = null;
  let failures = 0;
  let retryAt = 0;
  let inFlight: Promise<void> | undefined;
  let controller: AbortController | undefined;
  const restore: (() => void)[] = [];
  const encoder = new TextEncoder();

  function trimQueue(): void {
    while (queue.length > MAX_QUEUE_EVENTS || queueBytes > MAX_QUEUE_BYTES) {
      const item = queue.shift();
      if (!item) break;
      queueBytes -= item.bytes;
      dropped++;
    }
  }

  function record(
    source: LogSource,
    level: LogLevel,
    ...args: unknown[]
  ): void {
    if (!active) return;
    try {
      const event: LogEvent = {
        ...context,
        eventId: `${context.sessionId}:${++sequence}`,
        timestamp: Date.now(),
        pageUrl: window.location.href.slice(0, 4096),
        level,
        source,
        args: snapshot(args) as JsonValue[],
      };
      const payload = event.args[0];
      if (
        source === "http" &&
        payload &&
        typeof payload === "object" &&
        !Array.isArray(payload) &&
        typeof payload.requestId === "string" &&
        payload.requestId.length <= 320
      )
        event.requestId = payload.requestId;
      let text = JSON.stringify(event);
      let bytes = encoder.encode(text).length;
      if (bytes > MAX_EVENT_BYTES) {
        event.args = [
          {
            truncated: true,
            reason: "单条日志超出 128 KiB",
            preview: JSON.stringify(event.args).slice(0, 12 * 1024),
          },
        ];
        text = JSON.stringify(event);
        bytes = encoder.encode(text).length;
      }
      queue.push({ text, bytes });
      queueBytes += bytes;
      recorded++;
      lastRecordedAt = event.timestamp;
      trimQueue();
    } catch (error) {
      dropped++;
      setFailure("capture", error instanceof Error ? error.message : "日志采集失败");
    }
  }

  function flush(): Promise<void> {
    if (inFlight) return inFlight;
    if (!active || !nativeFetch || queue.length === 0 || Date.now() < retryAt)
      return Promise.resolve();
    const batch: typeof queue = [];
    let bytes = 16;
    while (queue.length > 0 && batch.length < MAX_BATCH_EVENTS) {
      const next = queue[0];
      if (!next || bytes + next.bytes + 1 > MAX_BATCH_BYTES) break;
      batch.push(queue.shift()!);
      queueBytes -= next.bytes;
      bytes += next.bytes + 1;
    }
    const text = `{"events":[${batch.map((item) => item.text).join(",")}]}`;
    lastAttemptAt = Date.now();
    inFlightCount = batch.length;
    let failureStage: LoggerFailure["stage"] = "network";
    let httpStatus: number | null = null;
    controller = new AbortController();
    const requestController = controller;
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(requestController.signal.reason ?? new Error("日志上传已取消"));
      requestController.signal.addEventListener("abort", onAbort, { once: true });
    });
    // Guarantee: 取消信号即使未被底层请求响应，也不能永久占住发送锁。
    const timeout = setTimeout(() => requestController.abort(new Error("日志上传超时（5 秒）")), 5000);
    inFlight = (async () => {
      try {
        const upload = (async () => {
          let body: string | ArrayBuffer = text;
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          // Rule: 小批次不压缩；宿主具备原生流式压缩能力时才异步处理大批次。
          if (bytes >= 8 * 1024 && typeof CompressionStream !== "undefined") {
            phase = "compressing";
            failureStage = "compression";
            const compressed = await new Response(
              new Response(text).body!.pipeThrough(new CompressionStream("gzip"), { signal: requestController.signal }),
            ).arrayBuffer();
            if (compressed.byteLength < bytes) {
              body = compressed;
              headers["Content-Encoding"] = "gzip";
            }
          }
          if (!active || requestController.signal.aborted)
            throw requestController.signal.reason ?? new Error("日志采集已停止");
          phase = "uploading";
          failureStage = "network";
          return nativeFetch!(endpoint, {
            method: "POST", headers, body,
            signal: requestController.signal,
            keepalive: (typeof body === "string" ? bytes : body.byteLength) < 60 * 1024,
            credentials: "omit",
          });
        })();
        const response = await Promise.race([upload, cancelled]);
        httpStatus = response.status;
        lastHttpStatus = httpStatus;
        failureStage = "http";
        if (!response.ok) {
          if (
            response.status >= 400 &&
            response.status < 500 &&
            response.status !== 429
          ) {
            dropped += batch.length;
            setFailure("http", `日志上传被拒绝：HTTP ${response.status}`, httpStatus);
            return;
          }
          throw new Error(`日志上传失败：HTTP ${response.status}`);
        }
        sent += batch.length;
        lastSentAt = Date.now();
        failures = 0;
        retryAt = 0;
        lastError = null;
      } catch (error) {
        if (!active) return;
        queue.unshift(...batch);
        queueBytes += batch.reduce((sum, item) => sum + item.bytes, 0);
        trimQueue();
        failures++;
        retryAt =
          Date.now() + Math.min(30000, 1000 * 2 ** Math.min(failures - 1, 5));
        setFailure(failureStage, error instanceof Error ? error.message : "日志服务不可用", httpStatus);
      } finally {
        clearTimeout(timeout);
        requestController.signal.removeEventListener("abort", onAbort);
        controller = undefined;
        inFlight = undefined;
        inFlightCount = 0;
        phase = "idle";
      }
    })();
    return inFlight;
  }

  const logger: Logger = {
    context,
    record,
    flush,
    stop() {
      active = false;
      controller?.abort();
      for (const dispose of restore.splice(0)) dispose();
      queue.length = 0;
      queueBytes = 0;
      if (currentLogger === logger) currentLogger = undefined;
    },
    getStatus: () => ({
      enabled: active,
      queued: queue.length,
      dropped,
      lastError,
      sent,
      lastSentAt,
      retryAt: retryAt > Date.now() ? retryAt : null,
      recorded,
      lastRecordedAt,
      lastTickAt,
      inFlightCount,
      lastAttemptAt,
      phase,
      lastHttpStatus,
      lastFailure: lastFailure ? { ...lastFailure } : null,
      state: !active
        ? "disabled"
        : inFlight
          ? "sending"
          : retryAt > Date.now()
            ? "retrying"
            : "idle",
    }),
  };

  if (active) {
    currentLogger = logger;
    if (options.captureFetch === true) restore.push(attachFetchLogger(logger));
    if (options.captureConsole !== false) {
      for (const level of levels) {
        const original = console[level];
        const wrapper = function (this: Console, ...args: unknown[]): void {
          original.apply(console, args);
          record("console", level, ...args);
        };
        console[level] = wrapper;
        restore.push(() => {
          if (console[level] === wrapper) console[level] = original;
        });
      }
    }
    if (options.captureErrors !== false) {
      const onError = (event: ErrorEvent): void =>
        record(
          "error",
          "error",
          event.error ?? {
            message: event.message,
            filename: event.filename,
            line: event.lineno,
            column: event.colno,
          },
        );
      const onRejection = (event: PromiseRejectionEvent): void =>
        record("error", "error", event.reason);
      window.addEventListener("error", onError);
      window.addEventListener("unhandledrejection", onRejection);
      restore.push(() => {
        window.removeEventListener("error", onError);
        window.removeEventListener("unhandledrejection", onRejection);
      });
    }
    const timer = setInterval(() => {
      lastTickAt = Date.now();
      void flush();
    }, flushInterval(options.flushIntervalMs));
    const onPageHide = (): void => {
      void flush();
    };
    const retryNow = (): void => {
      controller?.abort(new Error("网络或页面恢复，取消旧上传"));
      void (inFlight ?? Promise.resolve()).then(() => {
        if (!active) return;
        retryAt = 0;
        void flush();
      });
    };
    const onVisibility = (): void => {
      if (document.visibilityState === "visible") retryNow();
      else void flush();
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", retryNow);
    window.addEventListener("online", retryNow);
    document.addEventListener("visibilitychange", onVisibility);
    restore.push(() => {
      clearInterval(timer);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", retryNow);
      window.removeEventListener("online", retryNow);
      document.removeEventListener("visibilitychange", onVisibility);
    });
  }
  return logger;
}
