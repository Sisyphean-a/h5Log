// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import type { LogClient, LogPage, StoredLog } from "@h5-log/sdk";
const client: LogClient = {
  key: "client",
  appId: "26",
  environment: "test",
  deviceId: "phone",
  sessionId: "session",
  deviceName: "phone",
  userAgent: "WebView",
  lastSeen: Date.now(),
  logCount: 300,
  errorCount: 0,
};
function item(id: number): StoredLog {
  return {
    ...client,
    id,
    clientKey: client.key,
    receivedAt: Date.now(),
    timestamp: Date.now(),
    eventId: String(id),
    pageUrl: "/",
    level: "info",
    source: "console",
    args: [`entry ${id}`],
  };
}
function response(cursor: number): { ok: true; json: () => Promise<LogPage> } {
  return {
    ok: true,
    json: async () => ({
      logs: Array.from({ length: 200 }, (_, i) => item(i + 1)),
      clients: [client],
      sessions: [],
      cursor,
      hasMore: true,
      total: cursor,
      retentionHours: 12,
      serverId: "server",
    }),
  };
}
class Stream extends EventTarget {
  static instances: Stream[] = [];
  constructor() {
    super();
    Stream.instances.push(this);
  }
  close() {}
  emit(name: string, data: unknown) {
    this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) }));
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
it("重连后重新读取同一个历史页并合入断线期间的新日志", async () => {
  document.body.innerHTML = readFileSync(
    "packages/web/index.html",
    "utf8",
  ).match(/<body>([\s\S]*)<\/body>/)![1]!;
  let finish!: (value: ReturnType<typeof response>) => void;
  let finishReconnect!: (value: ReturnType<typeof response>) => void;
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(response(300))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishReconnect = resolve;
        }),
    )
    .mockResolvedValue(response(310));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", Stream);
  await import("../src/main.js");
  await vi.waitFor(() =>
    expect(document.querySelectorAll(".log-row")).toHaveLength(200),
  );
  const first = Stream.instances.at(-1)!;
  first.emit("hello", { serverId: "server", clients: [client] });
  document.querySelector<HTMLButtonElement>("#older")!.click();
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  finish(response(300));
  await vi.waitFor(() =>
    expect(document.querySelector("#view-title")!.textContent).toBe("历史日志"),
  );
  window.dispatchEvent(
    new PageTransitionEvent("pagehide", { persisted: true }),
  );
  window.dispatchEvent(
    new PageTransitionEvent("pageshow", { persisted: true }),
  );
  const second = Stream.instances.at(-1)!;
  expect(second).not.toBe(first);
  second.emit("hello", { serverId: "server", clients: [client] });
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
  expect(String(fetchMock.mock.calls.at(-1)![0])).toContain("before=1");
  second.emit("logs", { logs: [item(301)], clients: [client] });
  expect(document.querySelector("#scope-summary")!.textContent).toContain(
    "301 条",
  );
  finishReconnect(response(310));
  await vi.waitFor(() =>
    expect(document.querySelector("#view-title")!.textContent).toBe("历史日志"),
  );
});
