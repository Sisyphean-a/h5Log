// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/index.js";
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

describe("SDK 采集和生命周期", () => {
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
    expect(client.getStatus().enabled).toBe(false);
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
    expect(client.getStatus()).toMatchObject({ queued: 1000, dropped: 200 });
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
