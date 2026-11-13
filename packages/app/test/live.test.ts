// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { LogClient, LogPage, StoredLog } from "@h5-log/sdk";

const client: LogClient = {
  key: "test-client",
  appId: "26",
  environment: "test",
  deviceId: "test-phone",
  sessionId: "test-session",
  deviceName: "测试手机",
  userAgent: "WebView",
  lastSeen: Date.now(),
  logCount: 1,
  errorCount: 1,
};
function log(
  id: number,
  level: StoredLog["level"] = "error",
  source: StoredLog["source"] = "console",
): StoredLog {
  return {
    ...client,
    id,
    receivedAt: Date.now(),
    eventId: String(id),
    timestamp: Date.now(),
    clientKey: client.key,
    pageUrl: "https://h5.test",
    level,
    source,
    args: [`event ${id}`],
  };
}
function page(logs: StoredLog[] = [], cursor = 0): LogPage {
  const sessions: LogPage["sessions"] = ["test-session", "older-session"].map(
    (sessionId, index) => ({
      clientKey: client.key,
      sessionId,
      firstSeen: 100 + index,
      lastSeen: 101 + index,
      logCount: 5,
      errorCount: 1,
      pageUrl: "https://h5.test",
    }),
  );
  return {
    logs,
    clients: [client],
    sessions,
    total: logs.length,
    cursor,
    hasMore: false,
    retentionHours: 12,
    serverId: "test-server",
  };
}
function response(value: LogPage) {
  return { ok: true, json: async () => value };
}
class Stream extends EventTarget {
  static instances: Stream[] = [];
  closed = false;
  constructor(_url: string) {
    super();
    Stream.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  emit(name: string, data: unknown) {
    this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) }));
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("筛选缓冲不会被无关日志挤掉，清空使用全局游标，后退缓存恢复后重新接收", async () => {
  const html = readFileSync("packages/app/index.html", "utf8");
  document.body.innerHTML = html.match(/<body>([\s\S]*)<\/body>/)![1]!;
  const fetchPage = vi.fn().mockResolvedValue(response(page()));
  vi.stubGlobal("fetch", fetchPage);
  vi.stubGlobal("EventSource", Stream);
  await import("../src/web/main.js");
  await vi.waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1));
  await vi.waitFor(() =>
    expect(document.querySelector("#client-count")!.textContent).toBe("1"),
  );
  expect(document.querySelectorAll("#session option")).toHaveLength(3);
  expect(
    document.querySelector<HTMLSelectElement>("#session")!.options[2]!.value,
  ).toBe("older-session");
  const stream = Stream.instances[0]!;
  let finish!: (value: ReturnType<typeof response>) => void;
  fetchPage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const level = document.querySelector<HTMLSelectElement>("#level")!;
  level.value = "error";
  level.dispatchEvent(new Event("change"));
  stream.emit("logs", { logs: [log(1)], clients: [client] });
  for (let start = 2; start <= 202; start += 50)
    stream.emit("logs", {
      logs: Array.from({ length: 50 }, (_, i) => log(start + i, "info")),
      clients: [client],
    });
  finish(response(page()));
  await vi.waitFor(() =>
    expect(document.querySelectorAll(".log-row")).toHaveLength(1),
  );
  expect(document.querySelector<HTMLElement>(".log-row")!.dataset.id).toBe("1");
  await vi.waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(3));

  fetchPage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const source = document.querySelector<HTMLSelectElement>("#source")!;
  source.value = "bridge";
  source.dispatchEvent(new Event("change"));
  for (let start = 300; start <= 500; start += 50)
    stream.emit("logs", {
      logs: Array.from({ length: Math.min(50, 501 - start) }, (_, i) =>
        log(start + i, "error", "bridge"),
      ),
      clients: [client],
    });
  for (let start = 501; start <= 701; start += 50)
    stream.emit("logs", {
      logs: Array.from({ length: 50 }, (_, i) => log(start + i, "info")),
      clients: [client],
    });
  const duringLoad = log(702, "info", "console");
  duringLoad.sessionId = "during-load";
  const refreshed = page([], 702);
  refreshed.sessions.push({
    ...client,
    sessionId: "during-load",
    firstSeen: duringLoad.receivedAt,
    lastSeen: duringLoad.receivedAt,
    logCount: 1,
    errorCount: 0,
    pageUrl: duringLoad.pageUrl,
  });
  fetchPage.mockResolvedValue(response(refreshed));
  stream.emit("logs", { logs: [duringLoad], clients: [client] });
  finish(response(page([], 251)));
  await vi.waitFor(() =>
    expect(document.querySelectorAll(".log-row")).toHaveLength(200),
  );
  expect(document.querySelector<HTMLElement>(".log-row")!.dataset.id).toBe(
    "301",
  );
  expect(document.querySelector<HTMLButtonElement>("#older")!.disabled).toBe(
    false,
  );
  expect(document.querySelector("#scope-summary")!.textContent).toContain(
    "201 条",
  );
  expect(
    [...document.querySelector<HTMLSelectElement>("#session")!.options].some(
      (option) => option.value === "during-load",
    ),
  ).toBe(true);
  document.querySelector<HTMLButtonElement>("#clear")!.click();
  stream.emit("logs", {
    logs: [log(600, "error", "bridge")],
    clients: [client],
  });
  expect(document.querySelectorAll(".log-row")).toHaveLength(0);
  stream.emit("logs", {
    logs: [log(751, "error", "bridge")],
    clients: [client],
  });
  expect(document.querySelectorAll(".log-row")).toHaveLength(1);

  fetchPage.mockResolvedValue(
    response(page([log(751, "error", "bridge")], 751)),
  );
  window.dispatchEvent(
    new PageTransitionEvent("pagehide", { persisted: true }),
  );
  expect(stream.closed).toBe(true);
  window.dispatchEvent(
    new PageTransitionEvent("pageshow", { persisted: true }),
  );
  expect(Stream.instances).toHaveLength(2);
  const restored = Stream.instances[1]!;
  restored.emit("hello", { serverId: "test-server", clients: [client] });
  await vi.waitFor(() =>
    expect(document.querySelector<HTMLElement>(".log-row")?.dataset.id).toBe(
      "751",
    ),
  );
  restored.emit("logs", {
    logs: [log(752, "error", "bridge")],
    clients: [client],
  });
  await vi.waitFor(() =>
    expect(document.querySelectorAll(".log-row")).toHaveLength(2),
  );
  const focused = document.querySelector<HTMLElement>(".log-row summary")!;
  focused.focus();
  restored.emit("logs", {
    logs: [log(753, "error", "bridge")],
    clients: [client],
  });
  expect(document.querySelectorAll(".log-row")).toHaveLength(3);
  expect(document.activeElement).toBe(focused);
  window.dispatchEvent(new PageTransitionEvent("pagehide"));
});
