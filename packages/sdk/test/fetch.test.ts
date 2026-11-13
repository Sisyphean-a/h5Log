import { afterEach, describe, expect, it, vi } from "vitest";
import { attachFetchLogger } from "../src/fetch.js";
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
afterEach(() => detach());

describe("fetch 采集", () => {
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
