// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/index.js";
import axios, { AxiosError, AxiosHeaders } from "axios";
import { attachAxiosLogger } from "../src/axios.js";
import type { Logger } from "../src/types.js";
import { CompressionStream as NativeCompressionStream } from "node:stream/web";
import { gunzipSync } from "node:zlib";

let logger: Logger | undefined;
let upload: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  upload = vi.fn().mockResolvedValue({ ok: true, status: 202 });
  vi.stubGlobal("fetch", upload);
  vi.stubGlobal("CompressionStream", undefined);
});
afterEach(() => {
  logger?.stop();
  logger = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function start(extra = {}) {
  logger = createLogger({
    enabled: true,
    appId: "26",
    endpoint: "https://logs.test/api/logs",
    captureConsole: false,
    ...extra,
  });
  return logger;
}
function sent() {
  return JSON.parse(upload.mock.calls.at(-1)![1].body as string) as {
    events: { args: unknown[]; source: string }[];
  };
}

describe("SDK 设备身份", () => {
  it("使用宿主提供的稳定标识，不读写随机设备存储，并随日志上传", async () => {
    const reads = vi.spyOn(Storage.prototype, "getItem").mockReturnValue("old-random-device");
    const writes = vi.spyOn(Storage.prototype, "setItem");
    const client = start({ deviceId: "gaid-phone-a", deviceName: "SM-A156U" });
    client.record("custom", "info", "identity-probe");
    await client.flush();

    expect(client.context).toMatchObject({ deviceId: "gaid-phone-a", deviceName: "SM-A156U" });
    expect(sent().events[0]).toMatchObject({ deviceId: "gaid-phone-a", deviceName: "SM-A156U" });
    expect(reads).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();

    const session = client.context.sessionId;
    const reopened = start({ deviceId: "gaid-phone-a" });
    expect(reopened.context.deviceId).toBe("gaid-phone-a");
    expect(reopened.context.sessionId).not.toBe(session);
  });
});

describe("SDK 本地诊断", () => {
  it("区分采集、在途批次和定时器心跳，读取快照不产生 IO 或额外定时器", async () => {
    vi.setSystemTime(10000);
    let complete!: (response: { ok: boolean; status: number }) => void;
    upload.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const client = start();
    const writes = vi.spyOn(Storage.prototype, "setItem");
    const timers = vi.getTimerCount();
    expect(client.getStatus()).toMatchObject({
      recorded: 0, lastRecordedAt: null, lastTickAt: null,
      inFlightCount: 0, lastAttemptAt: null, phase: "idle",
      lastHttpStatus: null, lastFailure: null,
    });
    for (let i = 0; i < 10; i++) client.getStatus();
    expect(vi.getTimerCount()).toBe(timers);
    expect(writes).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();

    client.record("custom", "info", "first");
    expect(client.getStatus()).toMatchObject({ recorded: 1, lastRecordedAt: 10000, queued: 1 });
    const sending = client.flush();
    client.record("custom", "info", "next batch");
    expect(client.getStatus()).toMatchObject({
      recorded: 2, queued: 1, inFlightCount: 1,
      lastAttemptAt: 10000, phase: "uploading", state: "sending",
    });
    expect(JSON.stringify(client.getStatus())).not.toContain("next batch");
    await vi.advanceTimersByTimeAsync(500);
    expect(client.getStatus().lastTickAt).toBe(10500);
    expect(upload).toHaveBeenCalledOnce();
    complete({ ok: true, status: 202 });
    await sending;
    expect(client.getStatus()).toMatchObject({
      queued: 1, inFlightCount: 0, phase: "idle", sent: 1,
      lastHttpStatus: 202, lastSentAt: 10500,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.getStatus()).toMatchObject({ recorded: 2, sent: 2, lastTickAt: 11500 });
    client.stop();
    client.record("custom", "info", "ignored after stop");
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.getStatus()).toMatchObject({ enabled: false, recorded: 2, lastTickAt: 11500 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("初始化和采集失败可区分，返回的失败快照不能修改 SDK 内部状态", () => {
    const invalid = start({ endpoint: "" });
    expect(invalid.getStatus()).toMatchObject({
      enabled: false, recorded: 0, lastTickAt: null,
      lastFailure: { stage: "initialization", httpStatus: null },
    });
    const client = start();
    vi.spyOn(JSON, "stringify").mockImplementationOnce(() => { throw new Error("snapshot failed"); });
    client.record("custom", "info", "not queued");
    const status = client.getStatus();
    expect(status).toMatchObject({
      recorded: 0, lastRecordedAt: null, queued: 0, dropped: 1,
      lastError: "snapshot failed",
      lastFailure: { stage: "capture", message: "snapshot failed", httpStatus: null, at: Date.now() },
    });
    Object.assign(status.lastFailure!, { message: "changed by caller" });
    expect(client.getStatus().lastFailure?.message).toBe("snapshot failed");
    client.record("custom", "info", "queued");
    expect(client.getStatus()).toMatchObject({ recorded: 1, queued: 1 });
  });

  it.each([400, 429, 503])("保留 HTTP %i 的失败详情，但不改变丢弃或退避策略", async (status) => {
    upload.mockResolvedValueOnce({ ok: false, status });
    const client = start();
    client.record("custom", "info", "request");
    await client.flush();
    const failure = client.getStatus().lastFailure;
    expect(client.getStatus()).toMatchObject({
      phase: "idle", inFlightCount: 0, lastHttpStatus: status,
      queued: status === 400 ? 0 : 1,
      dropped: status === 400 ? 1 : 0,
      state: status === 400 ? "idle" : "retrying",
      lastFailure: { stage: "http", httpStatus: status, at: Date.now() },
    });
    if (status === 400) {
      client.record("custom", "info", "next request");
      await client.flush();
    } else {
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(client.getStatus()).toMatchObject({
      lastError: null, lastHttpStatus: 202, phase: "idle", sent: 1, lastFailure: failure,
    });
  });

  it("网络挂起可见在途数量，超时与恢复后仍保留最近失败供诊断", async () => {
    upload.mockImplementationOnce(() => new Promise(() => {}));
    const client = start();
    client.record("custom", "info", "pending");
    const sending = client.flush();
    expect(client.getStatus()).toMatchObject({ phase: "uploading", inFlightCount: 1, queued: 0 });
    await vi.advanceTimersByTimeAsync(5000);
    await sending;
    expect(client.getStatus()).toMatchObject({
      phase: "idle", inFlightCount: 0, queued: 1, lastHttpStatus: null,
      lastFailure: { stage: "network", httpStatus: null, at: Date.now() },
    });
    expect(client.getStatus().lastFailure?.message).toContain("超时");
    const failure = client.getStatus().lastFailure;
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.getStatus()).toMatchObject({ sent: 1, lastError: null, lastFailure: failure });
  });

  it("压缩挂起和超时可定位，迟到的压缩结果不会污染下一批状态", async () => {
    vi.stubGlobal("CompressionStream", NativeCompressionStream);
    let complete!: (body: ArrayBuffer) => void;
    vi.spyOn(Response.prototype, "arrayBuffer").mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const client = start();
    client.record("custom", "info", "large payload".repeat(1000));
    const sending = client.flush();
    expect(client.getStatus()).toMatchObject({ phase: "compressing", inFlightCount: 1, queued: 0 });
    expect(upload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    await sending;
    expect(client.getStatus()).toMatchObject({
      phase: "idle", inFlightCount: 0, queued: 1,
      lastFailure: { stage: "compression", httpStatus: null },
    });
    vi.stubGlobal("CompressionStream", undefined);
    upload.mockImplementationOnce(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.getStatus()).toMatchObject({ phase: "uploading", inFlightCount: 1 });
    complete(new ArrayBuffer(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getStatus()).toMatchObject({ phase: "uploading", inFlightCount: 1 });
    client.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getStatus()).toMatchObject({ phase: "idle", inFlightCount: 0, state: "disabled" });
  });
});

describe("SDK 采集和生命周期", () => {
  it("上传挂起后业务 200、失败及后续日志仍被记录，上传恢复后整批送达", async () => {
    upload.mockImplementationOnce(() => new Promise(() => {}));
    const client = start();
    let failure: AxiosError | undefined;
    const business = axios.create({ adapter: async (config) => {
      const response = { config, status: config.url === "/fail" ? 500 : 200, statusText: "test", headers: new AxiosHeaders(), data: '{"ok":true}' };
      if (config.url === "/fail") {
        failure = new AxiosError("original failure", "ERR_BAD_RESPONSE", config, undefined, response);
        throw failure;
      }
      return response;
    } });
    const detach = attachAxiosLogger(business, client);
    try {
      expect((await business.get("/first")).status).toBe(200);
      expect((await business.get("/second")).status).toBe(200);
      void client.flush();
      expect((await business.get("/later")).status).toBe(200);
      await expect(business.get("/fail")).rejects.toSatisfy((error) => error === failure);
      client.record("console", "info", "after business calls");
      expect(client.getStatus()).toMatchObject({ enabled: true, state: "sending", queued: 5 });
      await vi.advanceTimersByTimeAsync(6000);
      expect(upload).toHaveBeenCalledTimes(2);
      expect(client.getStatus()).toMatchObject({ sent: 9, queued: 0, lastError: null });
      const phases = sent().events.filter((event) => event.source === "http").map((event) => event.args[0] as { phase: string; status?: number });
      expect(phases.filter((entry) => entry.phase === "response").map((entry) => entry.status)).toEqual([200, 200, 200]);
      expect(phases.find((entry) => entry.phase === "error")?.status).toBe(500);
      expect(sent().events.at(-1)!.args).toEqual(["after business calls"]);
    } finally {
      detach();
    }
  });
  it.each(["name", "message", "stack", "cause"] as const)("Error 的 %s 访问器不会被日志采集执行", async (property) => {
    const client = start();
    const error = new Error("unsafe error");
    const getter = vi.fn(() => { throw new Error("getter must not run"); });
    Object.defineProperty(error, property, { configurable: true, get: getter });
    client.record("error", "error", error);
    await client.flush();
    expect(getter).not.toHaveBeenCalled();
    expect(sent().events[0]!.args[0]).toMatchObject({ [property]: "[Getter]" });
  });

  it("Error 继承的访问器也不执行，普通错误仍保留类型、堆栈与原因", async () => {
    const client = start();
    const getter = vi.fn(() => "UnsafeError");
    const unsafe = new Error("inherited getter");
    Object.setPrototypeOf(unsafe, Object.create(Error.prototype, { name: { get: getter } }));
    client.record("error", "error", unsafe);
    client.record("error", "error", new TypeError("outer error", { cause: new Error("inner error") }));
    await client.flush();
    expect(getter).not.toHaveBeenCalled();
    expect(sent().events[0]!.args[0]).toMatchObject({ name: "[Getter]" });
    const normal = sent().events[1]!.args[0] as { stack: string };
    expect(normal).toMatchObject({ name: "TypeError", message: "outer error", cause: { name: "Error", message: "inner error" } });
    expect(normal.stack).toContain("outer error");
  });

  it("自定义堆栈格式化访问器也不会被原生惰性 stack 间接执行", async () => {
    const client = start();
    const original = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
    const error = new Error("custom formatter");
    const getter = vi.fn(() => undefined);
    try {
      Object.defineProperty(Error, "prepareStackTrace", { configurable: true, get: getter });
      client.record("error", "error", error);
      await client.flush();
    } finally {
      if (original) Object.defineProperty(Error, "prepareStackTrace", original);
      else Reflect.deleteProperty(Error, "prepareStackTrace");
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it("大批次原生异步压缩，小批次和不支持压缩的宿主仍用原始 JSON", async () => {
    vi.useRealTimers();
    const client = start();
    const text = "保留完整业务正文".repeat(600);
    client.record("custom", "info", text);
    await client.flush();
    expect(upload.mock.calls[0]![1].headers["Content-Encoding"]).toBeUndefined();
    expect(sent().events[0]!.args).toEqual([text]);
    vi.stubGlobal("CompressionStream", NativeCompressionStream);
    client.record("custom", "info", text);
    await client.flush();
    const request = upload.mock.calls[1]![1];
    expect(request.headers["Content-Encoding"]).toBe("gzip");
    const bytes = new Uint8Array(request.body as ArrayBuffer);
    const decoded = gunzipSync(bytes).toString("utf8");
    expect(JSON.parse(decoded).events[0].args).toEqual([text]);
    expect(bytes.length).toBeLessThan(new TextEncoder().encode(decoded).length / 2);
    client.record("custom", "info", "small");
    await client.flush();
    expect(upload.mock.calls[2]![1].headers["Content-Encoding"]).toBeUndefined();
  });

  it("压缩异常不向宿主抛出、不丢批次，也不伪装上传成功", async () => {
    vi.stubGlobal("CompressionStream", class {
      constructor() { throw new Error("compression failed"); }
    });
    const client = start();
    client.record("custom", "info", "payload".repeat(2000));
    await expect(client.flush()).resolves.toBeUndefined();
    expect(upload).not.toHaveBeenCalled();
    expect(client.getStatus()).toMatchObject({ queued: 1, sent: 0, lastError: "compression failed", state: "retrying" });
  });

  it.each([
    ["小批次", "small payload", false],
    ["大批次 JSON", "large payload".repeat(1000), false],
    ["大批次 gzip", "large payload".repeat(1000), true],
  ] as const)("%s 不使用 keepalive，宿主拒绝此类请求时仍连续送达", async (_name, payload, compress) => {
    vi.useRealTimers();
    if (compress) vi.stubGlobal("CompressionStream", NativeCompressionStream);
    upload.mockImplementation(async (_url: string, init: RequestInit) => {
      if (init.keepalive) throw new TypeError("Failed to fetch");
      return { ok: true, status: 202 };
    });
    const client = start();
    for (let i = 0; i < 2; i++) {
      client.record("custom", "info", payload);
      await client.flush();
      expect(client.getStatus()).toMatchObject({ sent: i + 1, queued: 0, dropped: 0, lastError: null });
    }
    expect(upload).toHaveBeenCalledTimes(2);
    for (const [, init] of upload.mock.calls) {
      expect(init.keepalive).not.toBe(true);
      expect(init.headers["Content-Encoding"]).toBe(compress ? "gzip" : undefined);
    }
  });

  it("小批次 flush 在返回前发起请求，不等待定时器或微任务", async () => {
    const client = start();
    client.record("custom", "info", "before native navigation");
    const sending = client.flush();
    expect(upload).toHaveBeenCalledOnce();
    expect(client.getStatus().state).toBe("sending");
    await sending;
    expect(client.getStatus().sent).toBe(1);
  });

  it("上传即使未响应取消也在五秒后释放发送锁并继续重试", async () => {
    upload.mockImplementationOnce(() => new Promise(() => {}));
    const client = start();
    client.record("custom", "info", "retained");
    const sending = client.flush();
    await vi.advanceTimersByTimeAsync(5000);
    await sending;
    expect(client.getStatus()).toMatchObject({ queued: 1, state: "retrying" });
    expect(client.getStatus().lastError).toContain("超时");
    await vi.advanceTimersByTimeAsync(1000);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(client.getStatus()).toMatchObject({ sent: 1, queued: 0, lastError: null });
  });

  it("联网恢复立即取消旧上传并重试，停止后不再因生命周期事件发送", async () => {
    upload.mockImplementationOnce(() => new Promise(() => {}));
    const client = start();
    client.record("custom", "info", "retained");
    void client.flush();
    await vi.advanceTimersByTimeAsync(0);
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(client.getStatus().sent).toBe(1);
    client.stop();
    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("pageshow"));
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(10000);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("页面恢复可见立即重试，不等待断网退避结束", async () => {
    upload.mockRejectedValueOnce(new Error("proxy switched"));
    const client = start();
    client.record("custom", "info", "retained");
    await client.flush();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(client.getStatus()).toMatchObject({ sent: 1, queued: 0 });
  });
  it("显式关闭时不改写 console、不上传", async () => {
    const original = console.info;
    const client = start({ enabled: false, captureConsole: true });
    client.record("custom", "info", "ignored");
    await client.flush();
    expect(console.info).toBe(original);
    expect(upload).not.toHaveBeenCalled();
    expect(client.getStatus()).toMatchObject({
      enabled: false, recorded: 0, lastRecordedAt: null, lastTickAt: null,
      lastAttemptAt: null, inFlightCount: 0, phase: "idle", lastFailure: null,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("保留 console 行为，记录调用时对象快照，停止后恢复", async () => {
    const original = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);
    const client = start({ captureConsole: true });
    const data = { count: 1 };
    console.info("hello", data);
    data.count = 2;
    await client.flush();
    expect(original).toHaveBeenCalledWith("hello", data);
    expect(sent().events[0]!.args).toEqual(["hello", { count: 1 }]);
    client.stop();
    expect(console.info).toBe(original);
  });

  it("循环、Error、大整数和 getter 可以记录，getter 不执行", async () => {
    const client = start();
    const getter = vi.fn(() => {
      throw new Error("must not run");
    });
    const object: Record<string, unknown> = { value: 2n };
    object.self = object;
    Object.defineProperty(object, "secret", { enumerable: true, get: getter });
    client.record("custom", "error", object, new Error("boom"));
    await client.flush();
    expect(sent().events[0]!.args[0]).toEqual({
      value: "2n",
      self: "[Circular]",
      secret: "[Getter]",
    });
    expect(sent().events[0]!.args[1]).toMatchObject({
      name: "Error",
      message: "boom",
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it("采集全局异常和 Promise 异常", async () => {
    const client = start();
    window.dispatchEvent(
      new ErrorEvent("error", { error: new Error("runtime failure") }),
    );
    const rejection = new Event("unhandledrejection");
    Object.defineProperty(rejection, "reason", {
      value: new Error("promise failure"),
    });
    window.dispatchEvent(rejection);
    await client.flush();
    expect(sent().events.map((event) => event.source)).toEqual([
      "error",
      "error",
    ]);
    expect(
      sent().events.map(
        (event) => (event.args[0] as { message: string }).message,
      ),
    ).toEqual(["runtime failure", "promise failure"]);
  });

  it("仅三项配置就通过 console 采集完整桥接日志，无需额外接入", async () => {
    const original = vi.spyOn(console, "info").mockImplementation(() => undefined);
    logger = createLogger({
      enabled: true,
      appId: "26",
      endpoint: "https://logs.test/api/logs",
    });
    const message = "a".repeat(1000);
    console.info("桥接发送", message);
    await logger.flush();
    expect(original).toHaveBeenCalledWith("桥接发送", message);
    expect(sent().events).toHaveLength(1);
    expect(sent().events[0]).toMatchObject({
      source: "console",
      args: ["桥接发送", message],
    });
  });

  it("单条超大日志留下明确限制标记", async () => {
    const client = start();
    client.record("custom", "info", "中".repeat(70000));
    await client.flush();
    expect(sent().events[0]!.args[0]).toMatchObject({ truncated: true });
    expect(
      new TextEncoder().encode(upload.mock.calls[0]![1].body as string).length,
    ).toBeLessThan(128 * 1024);
  });

  it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY])("默认或无效合批间隔 %s 使用 500ms，空队列不请求", async (flushIntervalMs) => {
    const client = start({ flushIntervalMs });
    const startedAt = Date.now();
    client.record("custom", "info", "batched");
    await vi.advanceTimersByTimeAsync(499);
    expect(upload).not.toHaveBeenCalled();
    expect(client.getStatus().lastTickAt).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(upload).toHaveBeenCalledOnce();
    expect(client.getStatus()).toMatchObject({ sent: 1, lastTickAt: startedAt + 500 });
    await vi.advanceTimersByTimeAsync(1500);
    expect(upload).toHaveBeenCalledOnce();
    expect(client.getStatus().lastTickAt).toBe(startedAt + 2000);
  });

  it("按 flushIntervalMs 定时合批上传，越界值被夹到安全区间", async () => {
    const client = start({ flushIntervalMs: 100 });
    client.record("custom", "info", "fast");
    await vi.advanceTimersByTimeAsync(99);
    expect(upload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(upload).toHaveBeenCalledTimes(1);

    client.record("custom", "info", "too small");
    await vi.advanceTimersByTimeAsync(10);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(client.getStatus().queued).toBe(1);
    client.stop();

    const clamped = start({ flushIntervalMs: 1 });
    clamped.record("custom", "info", "clamped");
    await vi.advanceTimersByTimeAsync(49);
    expect(upload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("断网时有限缓冲，退避后恢复上传", async () => {
    upload.mockRejectedValueOnce(new Error("offline"));
    const client = start();
    client.record("custom", "info", "retained");
    await client.flush();
    expect(client.getStatus()).toMatchObject({
      queued: 1,
      lastError: "offline",
    });
    await client.flush();
    expect(upload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.getStatus()).toMatchObject({ queued: 0, lastError: null });
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("连续网络失败达到 30 秒退避后仍继续尝试，不终止或丢弃批次", async () => {
    upload.mockRejectedValue(new TypeError("Failed to fetch"));
    const client = start();
    client.record("custom", "info", "retained across failures");
    await client.flush();
    let attempts = 1;
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      const previous = client.getStatus();
      expect(previous.retryAt).toBe(Date.now() + delay);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(upload).toHaveBeenCalledTimes(attempts);
      await vi.advanceTimersByTimeAsync(1);
      expect(upload).toHaveBeenCalledTimes(++attempts);
      expect(client.getStatus()).toMatchObject({
        enabled: true, queued: 1, dropped: 0, sent: 0, state: "retrying",
        lastAttemptAt: previous.lastAttemptAt! + delay,
      });
    }
  });

  it("同步抛出的上传错误不会卡死后续发送", async () => {
    upload.mockImplementationOnce(() => {
      throw new Error("sync failure");
    });
    const client = start();
    client.record("custom", "info", "retry");
    await client.flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(client.getStatus().queued).toBe(0);
  });

  it("大量普通值和多个长字符串共享整条快照预算", async () => {
    const client = start();
    client.record(
      "custom",
      "info",
      Array.from({ length: 10000 }, (_, i) => i),
    );
    client.record(
      "custom",
      "info",
      ...Array.from({ length: 50 }, () => "a".repeat(10000)),
    );
    await client.flush();
    const events = sent().events;
    const values = events[0]!.args[0] as unknown[];
    expect(values.length).toBeLessThanOrEqual(2000);
    expect(values.at(-1)).toBe("[达到快照容量上限]");
    expect(JSON.stringify(events[1]!.args).length).toBeLessThan(70000);
    expect(JSON.stringify(events[1]!.args)).toContain("字符串快照超出");
  });

  it("对象键、FormData 和 URLSearchParams 也遵守字符预算", async () => {
    const client = start();
    const name = "k".repeat(200000);
    const params = new URLSearchParams([[name, "value"]]);
    const stringify = vi.spyOn(params, "toString").mockImplementation(() => {
      throw new Error("must not stringify full params");
    });
    const form = new FormData();
    form.append(name, "value");
    client.record("custom", "info", { [name]: "value" });
    client.record("custom", "info", params);
    client.record("custom", "info", form);
    const sparse: unknown[] = [];
    sparse.length = 100000;
    client.record("custom", "info", sparse);
    await client.flush();
    const events = sent().events;
    for (const event of events.slice(0, 3)) {
      expect(JSON.stringify(event.args).length).toBeLessThan(70000);
      expect(JSON.stringify(event.args)).toContain("字符串快照超出");
    }
    expect((events[3]!.args[0] as unknown[]).length).toBeLessThanOrEqual(2000);
    expect(stringify).not.toHaveBeenCalled();
  });

  it("大日志截断后仍保留请求关联标识", async () => {
    const client = start();
    client.record("http", "info", {
      phase: "request",
      requestId: "request-large",
      body: "中".repeat(100000),
    });
    await client.flush();
    const data = JSON.parse(upload.mock.calls.at(-1)![1].body as string);
    expect(data.events[0].requestId).toBe("request-large");
    expect(data.events[0].args[0].truncated).toBe(true);
  });

  it("队列达到上限时淘汰旧记录，不无限占用内存", () => {
    const client = start();
    for (let i = 0; i < 1200; i++) client.record("custom", "info", i);
    expect(client.getStatus()).toMatchObject({ enabled: true, recorded: 1200, queued: 1000, dropped: 200 });
  });

  it("重复初始化不叠加 console 包装，同一客户端产生新页面会话", async () => {
    const original = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const first = start({ captureConsole: true });
    const second = start({ captureConsole: true });
    expect(first.getStatus().enabled).toBe(false);
    expect(first.context.deviceId).toBe(second.context.deviceId);
    expect(first.context.sessionId).not.toBe(second.context.sessionId);
    console.warn("once");
    await second.flush();
    expect(sent().events).toHaveLength(1);
    second.stop();
    expect(console.warn).toBe(original);
  });
});
