// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/index.js";
import type { Logger } from "../src/types.js";

let logger: Logger | undefined;
let upload: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  upload = vi.fn().mockResolvedValue({ ok: true, status: 202 });
  vi.stubGlobal("fetch", upload);
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

  it("不再把普通长桥接报文替换为 256 字符摘要", async () => {
    const client = start();
    const message = "a".repeat(1000);
    client.record("bridge", "info", message);
    await client.flush();
    expect(sent().events[0]!.args).toEqual([message]);
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
