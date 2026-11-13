// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createLogger } from "../src/index.js";

it("启用 fetch 采集时上传不被递归采集，在线恢复立即重试并更新状态", async () => {
  vi.useFakeTimers();
  const original = vi.fn().mockImplementation((input: RequestInfo | URL) => {
    if (String(input).includes("/api/logs"))
      return Promise.resolve(new Response("{}", { status: 202 }));
    return Promise.resolve(
      new Response('{"ok":true}', {
        headers: { "content-type": "application/json" },
      }),
    );
  });
  vi.stubGlobal("fetch", original);
  const logger = createLogger({
    enabled: true,
    appId: "26",
    endpoint: "https://log.test/api/logs",
    captureConsole: false,
    captureFetch: true,
  });
  try {
    await (await fetch("https://business.test/path")).json();
    await vi.waitFor(() => expect(logger.getStatus().queued).toBe(2));
    await logger.flush();
    expect(logger.getStatus()).toMatchObject({
      queued: 0,
      sent: 2,
      state: "idle",
    });
    expect(original).toHaveBeenCalledTimes(2);
    const payload = JSON.parse(original.mock.calls[1]![1].body as string);
    expect(
      payload.events.map((item: { source: string }) => item.source),
    ).toEqual(["http", "http"]);
    logger.record("custom", "info", "retry");
    original.mockRejectedValueOnce(new Error("offline"));
    await logger.flush();
    expect(logger.getStatus()).toMatchObject({
      queued: 1,
      state: "retrying",
      lastError: "offline",
    });
    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(logger.getStatus().sent).toBe(3));
    expect(logger.getStatus()).toMatchObject({
      queued: 0,
      state: "idle",
      lastError: null,
    });
  } finally {
    logger.stop();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
