// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import type { LogClient, LogPage, StoredLog } from "@h5-log/sdk";
const client: LogClient = {
  key: "client",
  appId: "26",
  environment: "test",
  deviceId: "phone",
  sessionId: "page",
  deviceName: "测试手机",
  userAgent: "WebView",
  lastSeen: 100,
  logCount: 2,
  errorCount: 1,
};
function log(
  id: number,
  level: StoredLog["level"],
  sessionId = "session-a",
): StoredLog {
  return {
    ...client,
    id,
    receivedAt: id,
    eventId: `event-${id}`,
    timestamp: id,
    clientKey: client.key,
    sessionId,
    pageUrl: "https://h5.test",
    source: "console",
    level,
    args: [`entry ${id}`],
  };
}
function page(logs: StoredLog[], cursor: number, logCount = 2): LogPage {
  return {
    logs,
    clients: [client],
    sessions: [
      {
        clientKey: client.key,
        sessionId: "session-a",
        firstSeen: 1,
        lastSeen: 10,
        logCount,
        errorCount: 1,
        pageUrl: "https://h5.test",
      },
    ],
    cursor,
    hasMore: false,
    total: logCount,
    retentionHours: 12,
    serverId: "server",
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
  vi.restoreAllMocks();
  vi.resetModules();
});

it("忽略快照游标内迟到的重复 SSE，只计入新日志一次", async () => {
  document.body.innerHTML = readFileSync(
    "packages/web/index.html",
    "utf8",
  ).match(/<body>([\s\S]*)<\/body>/)![1]!;
  window.history.replaceState(null, "", "/?level=error");
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => page([log(10, "error")], 10),
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", Stream);
  await import("../src/main.js");
  await vi.waitFor(() =>
    expect(document.querySelector(".log-row")).not.toBeNull(),
  );
  const stream = Stream.instances.at(-1)!;
  stream.emit("logs", { logs: [log(9, "info")], clients: [client] });
  expect(
    document
      .querySelector<HTMLSelectElement>("#session")!
      .querySelector("option[value='session-a']")!.textContent,
  ).toContain("2 条");
  stream.emit("logs", { logs: [log(11, "info")], clients: [client] });
  expect(
    document
      .querySelector<HTMLSelectElement>("#session")!
      .querySelector("option[value='session-a']")!.textContent,
  ).toContain("3 条");
  stream.emit("clients", {
    clients: [client],
    expiresBefore: 0,
    evictedThroughId: 9,
  });
  expect(document.querySelectorAll(".log-row")).toHaveLength(1);
  stream.emit("clients", {
    clients: [],
    expiresBefore: 0,
    evictedThroughId: 11,
  });
  expect(document.querySelectorAll(".log-row")).toHaveLength(0);
  expect(document.querySelector("#inspector")!.hidden).toBe(true);
});
