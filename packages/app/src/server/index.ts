import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { promisify } from "node:util";
import { constants, createGzip, gzip, gunzip, type Gzip } from "node:zlib";
import { createLogMatcher } from "../log-filter.js";
import { parseLogRoute } from "../log-route.js";
import { CONTEXT_LIMITS, MAX_BATCH_EVENTS, MAX_EVENT_BYTES } from "@h5-log/sdk";
import type { LogEvent } from "@h5-log/sdk";
import { LogStore } from "./store.js";
import type { LogFilter } from "./store.js";
import { createResourceMonitor } from "./resource-monitor.js";
export { LogStore } from "./store.js";

const MAX_BODY_BYTES = 1024 * 1024;
const compress = promisify(gzip);
const decompress = promisify(gunzip);

function acceptsGzip(request: IncomingMessage): boolean {
  const accepted = new Map((request.headers["accept-encoding"] ?? "").split(",").map((entry) => {
    const [name, ...params] = entry.trim().toLowerCase().split(";");
    const quality = params.find((param) => param.trim().startsWith("q="));
    return [name, quality ? Number(quality.trim().slice(2)) : 1] as const;
  }));
  return (accepted.get("gzip") ?? accepted.get("*") ?? 0) > 0;
}
const levels = new Set(["debug", "info", "log", "warn", "error"]);
const sources = new Set(["console", "error", "http", "custom"]);

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ServerOptions {
  store?: LogStore;
  webRoot?: string;
  allowedOrigins?: string[];
}

async function json(request: IncomingMessage, response: ServerResponse, status: number, value: unknown): Promise<void> {
  let body = Buffer.from(JSON.stringify(value));
  response.appendHeader("Vary", "Accept-Encoding");
  if (body.length >= 1024 && acceptsGzip(request)) {
    body = await compress(body, { level: constants.Z_BEST_SPEED });
    response.setHeader("Content-Encoding", "gzip");
  }
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": body.length,
  });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (
    !request.headers["content-type"]
      ?.toLowerCase()
      .startsWith("application/json")
  )
    throw new HttpError(415, "需要 application/json");
  if (Number(request.headers["content-length"]) > MAX_BODY_BYTES) {
    request.resume();
    throw new HttpError(413, "请求超过 1 MiB");
  }
  const encoding = request.headers["content-encoding"]?.trim().toLowerCase();
  if (encoding && encoding !== "identity" && encoding !== "gzip")
    throw new HttpError(415, "仅支持 identity 或 gzip 编码");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length as number;
    if (bytes > MAX_BODY_BYTES) throw new HttpError(413, "请求超过 1 MiB");
    chunks.push(chunk as Buffer);
  }
  let body = Buffer.concat(chunks);
  if (encoding === "gzip") {
    try {
      // Rule: 解压后的上限与原始请求相同，压缩不能绕过资源限制。
      body = await decompress(body, { maxOutputLength: MAX_BODY_BYTES });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE")
        throw new HttpError(413, "解压后请求超过 1 MiB");
      throw new HttpError(400, "gzip 数据无效");
    }
  }
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "JSON 格式错误");
  }
}

function validateEvents(input: unknown): LogEvent[] {
  if (
    !input ||
    typeof input !== "object" ||
    !("events" in input) ||
    !Array.isArray(input.events) ||
    input.events.length < 1 ||
    input.events.length > MAX_BATCH_EVENTS
  ) {
    throw new HttpError(400, "events 必须包含 1–50 条日志");
  }
  return input.events.map((value: unknown): LogEvent => {
    if (!value || typeof value !== "object")
      throw new HttpError(400, "日志格式错误");
    const event = value as Record<string, unknown>;
    const text = (field: string, max: number, required = true): string => {
      const item = event[field];
      if (
        typeof item !== "string" ||
        item.length > max ||
        (required && item.length === 0)
      )
        throw new HttpError(400, `字段 ${field} 无效`);
      return item;
    };
    if (
      typeof event.timestamp !== "number" ||
      !Number.isFinite(event.timestamp) ||
      !levels.has(String(event.level)) ||
      !sources.has(String(event.source)) ||
      !Array.isArray(event.args)
    ) {
      throw new HttpError(400, "日志时间、级别、来源或内容无效");
    }
    const log: LogEvent = {
      appId: text("appId", CONTEXT_LIMITS.appId),
      environment: text("environment", CONTEXT_LIMITS.environment),
      deviceId: text("deviceId", CONTEXT_LIMITS.deviceId),
      sessionId: text("sessionId", CONTEXT_LIMITS.sessionId),
      eventId: text("eventId", 320),
      deviceName: text("deviceName", CONTEXT_LIMITS.deviceName, false),
      userAgent: text("userAgent", CONTEXT_LIMITS.userAgent, false),
      pageUrl: text("pageUrl", 4096, false),
      timestamp: event.timestamp,
      level: event.level as LogEvent["level"],
      source: event.source as LogEvent["source"],
      args: event.args as LogEvent["args"],
    };
    if (event.requestId !== undefined) log.requestId = text("requestId", 320);
    if (Buffer.byteLength(JSON.stringify(log)) > MAX_EVENT_BYTES)
      throw new HttpError(413, "单条日志超过 128 KiB");
    return log;
  });
}

function parseFilter(params: URLSearchParams): LogFilter {
  const filter: LogFilter = {};
  for (const key of [
    "appId",
    "environment",
    "clientKey",
    "sessionId",
    "level",
    "source",
    "search",
  ] as const) {
    const value = params.get(key);
    if (value) filter[key] = value;
  }
  for (const key of ["before", "after", "limit"] as const) {
    const value = params.get(key);
    if (value === null) continue;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0)
      throw new HttpError(400, `参数 ${key} 无效`);
    filter[key] = number;
  }
  return filter;
}

export function createLogServer(options: ServerOptions = {}) {
  const store = options.store ?? new LogStore();
  const subscribers = new Map<ServerResponse, {
    matcher: ReturnType<typeof createLogMatcher>;
    compressor: Gzip | undefined;
  }>();
  const startedAt = Date.now();
  const monitor = createResourceMonitor();
  const maxSubscribers = 50;
  const allowedOrigins = options.allowedOrigins ?? ["*"];
  const sendEvent = (
    response: ServerResponse,
    name: string,
    data: unknown,
  ): void => {
    if (response.destroyed) {
      subscribers.delete(response);
      return;
    }
    // Rule: 慢查看者断开后重新读取保留日志，不让其发送缓冲无限增长。
    const compressor = subscribers.get(response)?.compressor;
    if (response.writableLength + (compressor?.writableLength ?? 0) + (compressor?.readableLength ?? 0) > 1024 * 1024) {
      response.destroy();
      subscribers.delete(response);
      return;
    }
    (compressor ?? response).write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const broadcast = (name: string, data: unknown): void => {
    for (const subscriber of subscribers.keys()) sendEvent(subscriber, name, data);
  };

  const server = createServer((request, response) => {
    void (async () => {
      response.setHeader("X-Content-Type-Options", "nosniff");
      const origin = request.headers.origin;
      const url = new URL(request.url ?? "/", "http://localhost");
      const isWorkbenchStatus = url.pathname === "/api/status";
      if (
        origin &&
        !allowedOrigins.includes("*") &&
        !allowedOrigins.includes(origin)
      )
        throw new HttpError(403, "来源不允许");
      // Rule: 资源状态供同源工作台读取，不沿用 SDK 的跨域访问设置。
      if (origin && !isWorkbenchStatus) {
        response.setHeader(
          "Access-Control-Allow-Origin",
          allowedOrigins.includes("*") ? "*" : origin,
        );
        response.setHeader("Vary", "Origin");
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Content-Encoding",
          "Access-Control-Max-Age": "600",
        });
        response.end();
        return;
      }
      if ((url.pathname === "/api/health" || isWorkbenchStatus) && request.method === "GET") {
        const stats = store.stats();
        await json(request, response, 200, {
          status: "ok",
          ...stats,
          serverId: store.serverId,
          startedAt,
          now: Date.now(),
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
          subscribers: subscribers.size,
          retentionHours: store.retentionHours,
          limits: {
            ...stats.limits,
            maxSubscribers,
            maxEventBytes: MAX_EVENT_BYTES,
          },
          ...(isWorkbenchStatus ? { resources: monitor.read() } : {}),
        });
        return;
      }
      if (url.pathname === "/api/logs" && request.method === "POST") {
        const events = validateEvents(await readJson(request));
        const accepted = store.add(events);
        const update = {
          clients: store.clients(),
          expiresBefore: store.expiryCutoff(),
          evictedThroughId: store.stats().evictedThroughId,
        };
        for (const [subscriber, { matcher }] of subscribers) {
          const logs = accepted.filter(matcher.inScope);
          // Rule: 正文按设备范围分发；目录与清理水位只随该批发送一次。
          sendEvent(subscriber, logs.length ? "logs" : "clients", logs.length ? { logs, ...update } : update);
        }
        await json(request, response, 202, { accepted: accepted.length });
        return;
      }
      if (url.pathname === "/api/logs" && request.method === "GET") {
        await json(request, response, 200, store.page(parseFilter(url.searchParams)));
        return;
      }
      if (/^\/api\/logs\/\d+$/.test(url.pathname) && request.method === "GET") {
        const detail = store.detail(Number(url.pathname.split("/").at(-1)));
        if (!detail) throw new HttpError(404, "日志已过期或已被容量淘汰");
        await json(request, response, 200, detail);
        return;
      }
      if (url.pathname === "/api/stream" && request.method === "GET") {
        if (subscribers.size >= maxSubscribers)
          throw new HttpError(503, "查看连接已满，请稍后重试");
        const matcher = createLogMatcher(parseFilter(url.searchParams));
        const compressor = acceptsGzip(request)
          ? createGzip({ level: constants.Z_BEST_SPEED, flush: constants.Z_SYNC_FLUSH })
          : undefined;
        response.appendHeader("Vary", "Accept-Encoding");
        if (compressor) {
          response.setHeader("Content-Encoding", "gzip");
          compressor.on("error", () => response.destroy());
          compressor.pipe(response);
        }
        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        response.flushHeaders();
        subscribers.set(response, { matcher, compressor });
        sendEvent(response, "hello", {
          serverId: store.serverId,
          clients: store.clients(),
        });
        response.on("close", () => {
          subscribers.delete(response);
          compressor?.destroy();
        });
        return;
      }
      if (url.pathname.startsWith("/api/"))
        throw new HttpError(404, "接口不存在");
      if (!options.webRoot || !["GET", "HEAD"].includes(request.method ?? ""))
        throw new HttpError(404, "页面不存在");
      let pathname: string;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        throw new HttpError(400, "路径无效");
      }
      if (pathname.includes("\0") || pathname.includes("\\"))
        throw new HttpError(400, "路径无效");
      const route = parseLogRoute(url.pathname);
      const isLogRoute = route?.index === 0;
      const root = resolve(options.webRoot);
      const path = resolve(
        root,
        `.${pathname === "/" || isLogRoute ? "/index.html" : pathname}`,
      );
      if (!path.startsWith(`${root}${sep}`))
        throw new HttpError(403, "路径不允许");
      let file: Buffer;
      try {
        file = await readFile(path);
      } catch (error) {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          ["ENOENT", "ENOTDIR", "EISDIR"].includes(String(error.code))
        )
          throw new HttpError(404, "页面不存在；请先执行 npm run build");
        throw error;
      }
      if (isLogRoute) {
        const depth = url.pathname.split("/").filter(Boolean).length - (url.pathname.endsWith("/") ? 0 : 1);
        const base = "../".repeat(depth) || "./";
        file = Buffer.from(file.toString("utf8").replace("<head>", `<head><base href="${base}">`));
      }
      const types: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon",
        ".map": "application/json",
      };
      response.writeHead(200, {
        "Content-Type": types[extname(path)] ?? "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      response.end(request.method === "HEAD" ? undefined : file);
    })().catch(async (error: unknown) => {
      if (response.headersSent || response.destroyed) {
        response.destroy();
        return;
      }
      if (error instanceof HttpError)
        await json(request, response, error.status, { error: error.message });
      else {
        console.error("[h5-log]", error);
        await json(request, response, 500, { error: "服务器处理失败" });
      }
    });
  });
  server.once("listening", monitor.start);
  server.requestTimeout = 10000;
  const cleanup = setInterval(() => {
    store.prune();
    broadcast("clients", {
      clients: store.clients(),
      expiresBefore: store.expiryCutoff(),
      evictedThroughId: store.stats().evictedThroughId,
    });
  }, 15000);
  cleanup.unref();
  const closeStreams = (): void => {
    clearInterval(cleanup);
    for (const [subscriber, { compressor }] of subscribers) {
      if (compressor) compressor.end();
      else subscriber.end();
    }
    subscribers.clear();
  };
  server.once("close", () => {
    monitor.stop();
    closeStreams();
  });
  const close = async (): Promise<void> => {
    monitor.stop();
    closeStreams();
    if (!server.listening) return;
    const forceClose = setTimeout(() => server.closeAllConnections(), 5000);
    forceClose.unref();
    try {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    } finally {
      clearTimeout(forceClose);
    }
  };
  return { server, store, closeStreams, close };
}
