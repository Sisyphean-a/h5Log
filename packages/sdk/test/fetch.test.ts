import { afterEach, describe, expect, it, vi } from "vitest";
import { attachFetchLogger } from "../src/fetch.js";
import { snapshot } from "../src/serialize.js";
import type { Logger } from "../src/types.js";

function recorder() {
  const events: { level: string; data: any }[] = [];
  const logger = {
    context: { sessionId: "session" },
    getStatus: () => ({ enabled: true }),
    record: (_source: string, level: string, data: unknown) =>
      events.push({ level, data }),
  } as unknown as Logger;
  return { logger, events };
}
let detach = (): void => {};
afterEach(() => { detach(); vi.restoreAllMocks(); });

describe("fetch 采集", () => {
  it.each(["params", "form"] as const)("%s 请求正文在遍历源数据时就受预算限制，原正文不变", async (kind) => {
    const body = kind === "params" ? new URLSearchParams() : new FormData();
    for (let i = 0; i < 10000; i++) body.append("same", String(i));
    const entries = body.entries.bind(body);
    let visited = 0;
    const iterate = function* () { for (const entry of entries()) { visited++; yield entry; } };
    Object.defineProperty(body, "entries", { configurable: true, value: iterate });
    Object.defineProperty(body, Symbol.iterator, { configurable: true, value: iterate });
    const stringify = body instanceof URLSearchParams ? vi.spyOn(body, "toString") : undefined;
    const response = new Response(null, { status: 204 });
    const original = vi.fn().mockResolvedValue(response);
    const target = { fetch: original as typeof fetch };
    const { logger, events } = recorder();
    logger.record = (_source, level, data) => { events.push({ level, data: snapshot(data) }); };
    detach = attachFetchLogger(logger, target);
    const init = { method: "POST", body };
    expect(await target.fetch("https://business.test/form", init)).toBe(response);
    expect(original).toHaveBeenCalledExactlyOnceWith("https://business.test/form", init);
    expect(visited).toBeGreaterThan(0);
    expect(visited).toBeLessThanOrEqual(2000);
    if (stringify) expect(stringify).not.toHaveBeenCalled();
    expect(events[0]!.data.body.slice(0, 2)).toEqual([{ name: "same", value: "0" }, { name: "same", value: "1" }]);
    expect(JSON.stringify(events[0]!.data)).toContain("快照容量上限");
    expect(body.getAll("same")).toHaveLength(10000);
  });

  it("FormData 保留重复字段和文件元信息，不读取文件正文", async () => {
    const body = new FormData();
    body.append("name", "first");
    body.append("name", "second");
    body.append("upload", new Blob(["file body"], { type: "text/plain" }), "sample.txt");
    const file = body.get("upload") as File;
    const read = vi.spyOn(file, "arrayBuffer");
    const target = { fetch: vi.fn().mockResolvedValue(new Response(null, { status: 204 })) as typeof fetch };
    const { logger, events } = recorder();
    detach = attachFetchLogger(logger, target);
    await target.fetch("https://business.test/form", { method: "POST", body });
    expect(events[0]!.data.body).toEqual([
      { name: "name", value: "first" },
      { name: "name", value: "second" },
      { name: "upload", value: { file: "sample.txt", type: "text/plain", size: 9 } },
    ]);
    expect(read).not.toHaveBeenCalled();
  });
  it("保留原始 Response、记录请求正文和 JSON 响应", async () => {
    const response = new Response(
      JSON.stringify({ code: 1000, data: { id: 26 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    const target = {
      fetch: vi.fn().mockResolvedValue(response) as typeof fetch,
    };
    const { logger, events } = recorder();
    detach = attachFetchLogger(logger, target);
    const actual = await target.fetch("https://business.test/order", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: 100 }),
    });
    expect(actual).toBe(response);
    expect(await actual.json()).toEqual({ code: 1000, data: { id: 26 } });
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events[0]!.data).toMatchObject({
      phase: "request",
      body: { amount: 100 },
    });
    expect(events[1]!.data).toMatchObject({
      phase: "response",
      status: 200,
      body: { code: 1000, data: { id: 26 } },
    });
    expect(events[0]!.data.requestId).toBe(events[1]!.data.requestId);
  });

  it("复用 Request 流时不克隆正文，避免 tee 分支无限缓冲", async () => {
    const request = new Request("https://business.test/upload", {
      method: "POST",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("payload"));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    const clone = vi.spyOn(request, "clone");
    const target = {
      fetch: vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        if (input instanceof Request) {
          await input.text();
          return new Response("ok");
        }
        throw new Error("expected Request");
      }) as typeof fetch,
    };
    const { logger, events } = recorder();
    detach = attachFetchLogger(logger, target);
    const actual = await target.fetch(request);
    expect(await actual.text()).toBe("ok");
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(clone).not.toHaveBeenCalled();
    expect(events[0]!.data.body).toBe("[Request 流正文未采集]");
  });

  it("保留 HTTP 失败响应并记录正文；网络拒绝保留原始错误", async () => {
    const failure = new Error("offline");
    const target = {
      fetch: vi
        .fn()
        .mockResolvedValueOnce(
          new Response('{"msg":"failed"}', {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
        )
        .mockRejectedValueOnce(failure) as typeof fetch,
    };
    const { logger, events } = recorder();
    detach = attachFetchLogger(logger, target);
    const response = await target.fetch("https://business.test/fail");
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('{"msg":"failed"}');
    await vi.waitFor(() =>
      expect(events.some((item) => item.data.phase === "response")).toBe(true),
    );
    expect(events.find((item) => item.data.phase === "response")).toMatchObject(
      { level: "error", data: { status: 500, body: { msg: "failed" } } },
    );
    await expect(target.fetch("https://business.test/offline")).rejects.toBe(
      failure,
    );
    expect(events.at(-1)).toMatchObject({
      level: "error",
      data: { phase: "error", error: failure },
    });
  });

  it("流及二进制响应不克隆，超大正文有限读取且不影响业务正文", async () => {
    const big = "x".repeat(100000);
    const binary = new Response("binary", {
      headers: { "content-type": "application/octet-stream" },
    });
    const clone = vi.spyOn(binary, "clone");
    const target = {
      fetch: vi
        .fn()
        .mockResolvedValueOnce(binary)
        .mockResolvedValueOnce(
          new Response(big, { headers: { "content-type": "text/plain" } }),
        ) as typeof fetch,
    };
    const { logger, events } = recorder();
    detach = attachFetchLogger(logger, target);
    expect(
      await (await target.fetch("https://business.test/file")).text(),
    ).toBe("binary");
    expect(clone).not.toHaveBeenCalled();
    expect(await (await target.fetch("https://business.test/big")).text()).toBe(
      big,
    );
    await vi.waitFor(() =>
      expect(events.some((item) => item.data.body?.truncated)).toBe(true),
    );
    expect(
      events.find((item) => item.data.body?.truncated)!.data.body.preview
        .length,
    ).toBeLessThanOrEqual(65536);
  });

  it("日志器故障不影响业务，卸载恢复原始 fetch", async () => {
    const response = new Response("ok");
    const original = vi.fn().mockResolvedValue(response) as typeof fetch;
    const target = { fetch: original };
    const { logger } = recorder();
    logger.getStatus = () => {
      throw new Error("diagnostic failure");
    };
    detach = attachFetchLogger(logger, target);
    expect(await target.fetch("https://business.test")).toBe(response);
    detach();
    expect(target.fetch).toBe(original);
  });
});
