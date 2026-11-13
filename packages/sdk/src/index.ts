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
  LogLevel,
  LogSource,
} from "./types.js";
export type * from "./types.js";

const MAX_QUEUE_EVENTS = 1000;
const MAX_QUEUE_BYTES = 4 * 1024 * 1024;
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

/** Rule: 默认由 enabled 显式开关控制；启用时一个页面只保留一个采集器。 */
export function createLogger(options: LoggerOptions): Logger {
  let active = options.enabled === true && typeof window !== "undefined";
  let lastError: string | null = null;
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
      lastError = error instanceof Error ? error.message : "日志初始化失败";
    }
  }

  const queue: { text: string; bytes: number }[] = [];
  let queueBytes = 0;
  let sequence = 0;
  let dropped = 0;
  let sent = 0;
  let lastSentAt: number | null = null;
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
      trimQueue();
    } catch (error) {
      dropped++;
      lastError = error instanceof Error ? error.message : "日志采集失败";
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
    const body = `{"events":[${batch.map((item) => item.text).join(",")}]}`;
    controller = new AbortController();
    const requestController = controller;
    const timeout = setTimeout(() => requestController.abort(), 5000);
    inFlight = (async () => {
      try {
        const response = await Promise.resolve().then(() =>
          nativeFetch!(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
            signal: requestController.signal,
            keepalive: bytes < 60 * 1024,
            credentials: "omit",
          }),
        );
        if (!response.ok) {
          if (
            response.status >= 400 &&
            response.status < 500 &&
            response.status !== 429
          ) {
            dropped += batch.length;
            lastError = `日志上传被拒绝：HTTP ${response.status}`;
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
        lastError = error instanceof Error ? error.message : "日志服务不可用";
      } finally {
        clearTimeout(timeout);
        controller = undefined;
        inFlight = undefined;
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
      void flush();
    }, 1000);
    const onPageHide = (): void => {
      void flush();
    };
    const onOnline = (): void => {
      retryAt = 0;
      void flush();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") void flush();
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisibility);
    restore.push(() => {
      clearInterval(timer);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisibility);
    });
  }
  return logger;
}
