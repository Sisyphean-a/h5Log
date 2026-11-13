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
  logCount: 250,
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
function response(
  logs: StoredLog[],
  hasMore: boolean,
): { ok: true; json: () => Promise<LogPage> } {
  return {
    ok: true,
    json: async () => ({
      logs,
      clients: [client],
      sessions: [],
      cursor: 250,
      hasMore,
      total: 250,
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
it("历史分页维持历史模式并可返回实时", async () => {
  document.body.innerHTML = readFileSync(
    "packages/app/index.html",
    "utf8",
  ).match(/<body>([\s\S]*)<\/body>/)![1]!;
  let olderRequest!: (value: ReturnType<typeof response>) => void;
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      response(
        Array.from({ length: 200 }, (_, i) => item(i + 51)),
        true,
      ),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          olderRequest = resolve;
        }),
    )
    .mockResolvedValue(response([item(51)], true));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", Stream);
  await import("../src/web/main.js");
  await vi.waitFor(() =>
    expect(document.querySelectorAll(".log-row")).toHaveLength(200),
  );
  const stream = Stream.instances.at(-1)!;
  stream.emit("hello", { serverId: "server", clients: [client] });
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
  document.querySelector<HTMLButtonElement>("#older")!.click();
  await vi.waitFor(() => expect(olderRequest).toBeTypeOf("function"));
  olderRequest(
    response(
      Array.from({ length: 200 }, (_, i) => item(i + 1)),
      false,
    ),
  );
  await vi.waitFor(() =>
    expect(document.querySelector<HTMLElement>(".log-row")!.dataset.id).toBe(
      "1",
    ),
  );
  expect(document.querySelector("#view-title")!.textContent).toBe("历史日志");
  expect(document.querySelector<HTMLButtonElement>("#latest")!.hidden).toBe(
    false,
  );
  stream.emit("clients", { clients: [client], expiresBefore: 0, evictedThroughId: 1 });
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
  expect(fetchMock.mock.calls.map(call => String(call[0]))).toContain("/api/logs?limit=200&before=51");
  expect(document.querySelector("#view-title")!.textContent).toBe("历史日志");
  stream.emit("logs", { logs: [item(251)], clients: [client] });
  await vi.waitFor(() =>
    expect(document.querySelector("#scope-summary")!.textContent).toContain(
      "251 条",
    ),
  );
  document.querySelector<HTMLButtonElement>("#latest")!.click();
  await vi.waitFor(() =>
    expect(document.querySelector("#view-title")!.textContent).toBe("实时日志"),
  );
  expect(document.querySelector<HTMLButtonElement>("#latest")!.hidden).toBe(
    true,
  );
});
