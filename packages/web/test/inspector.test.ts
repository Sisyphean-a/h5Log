// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import type { StoredLog } from "@h5-log/sdk";
import { createInspector } from "../src/inspector.js";

function log(id: number, phase: string, requestId = "request-1"): StoredLog {
  return {
    id,
    receivedAt: Date.now(),
    timestamp: Date.now(),
    appId: "26",
    environment: "test",
    deviceId: "device",
    sessionId: "session",
    deviceName: "phone",
    userAgent: "WebView",
    eventId: `event-${id}`,
    clientKey: "client",
    pageUrl: "https://h5.test",
    source: "http",
    level: "info",
    args: [
      {
        phase,
        requestId,
        method: "POST",
        url: "/order",
        body: { nested: { amount: 100 } },
      },
    ],
    requestId,
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("同一请求收发合并查看，切换原始事件，迟到响应不会覆盖当前选择", async () => {
  document.body.innerHTML = readFileSync(
    "packages/web/index.html",
    "utf8",
  ).match(/<body>([\s\S]*)<\/body>/)![1]!;
  const first = log(1, "request");
  const reply = log(2, "response");
  const second = log(3, "request", "request-2");
  let finish!: (value: unknown) => void;
  const fetchMock = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue({
      ok: true,
      json: async () => ({ log: second, related: [] }),
    });
  vi.stubGlobal("fetch", fetchMock);
  const inspector = createInspector(async () => undefined);
  inspector.show(first);
  inspector.show(second);
  finish({ ok: true, json: async () => ({ log: first, related: [reply] }) });
  await vi.waitFor(() =>
    expect(document.querySelector("#detail-state")!.textContent).toBe(""),
  );
  expect(document.querySelector("#detail-content")!.textContent).toContain(
    "request-2",
  );
  expect(document.querySelector("#detail-content")!.textContent).not.toContain(
    "request-1",
  );
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ log: first, related: [reply] }),
  });
  inspector.show(first);
  await vi.waitFor(() =>
    expect(document.querySelectorAll(".detail-section")).toHaveLength(2),
  );
  expect(document.querySelector("#detail-content")!.textContent).toContain(
    "请求",
  );
  expect(document.querySelector("#detail-content")!.textContent).toContain(
    "响应",
  );
  (document.querySelector("#detail-raw") as HTMLButtonElement).click();
  expect(document.querySelector("#detail-content pre")!.textContent).toContain(
    '"request-1"',
  );
  inspector.close();
  expect(document.querySelector<HTMLElement>("#inspector")!.hidden).toBe(true);
});
