// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import type { LogClient, LogPage, StoredLog } from "@h5-log/sdk";
import { createLocalHistory } from "../src/web/history.js";

const client: LogClient = {
  key: "client",
  appId: "26",
  environment: "test",
  deviceId: "phone",
  sessionId: "session",
  deviceName: "phone",
  userAgent: "WebView",
  lastSeen: Date.now(),
  logCount: 12,
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

it("服务端窗口翻尽后继续用本地历史分页，并保存实时日志", async () => {
  document.body.innerHTML = readFileSync("packages/app/index.html", "utf8").match(
    /<body>([\s\S]*)<\/body>/,
  )![1]!;
  const page: LogPage = {
    logs: [item(11), item(12)],
    clients: [client],
    sessions: [],
    cursor: 12,
    hasMore: false,
    total: 12,
    retentionHours: 12,
    serverId: "server",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: true, json: async () => page }),
  );
  vi.stubGlobal("EventSource", Stream);

  // 上一次会话留在浏览器里的记录
  const previous = createLocalHistory()!;
  previous.setServerId("server");
  previous.append(Array.from({ length: 10 }, (_, i) => item(i + 1)));
  await previous.page({ limit: 1, accept: () => true });
  previous.dispose();

  await import("../src/web/main.js");
  await vi.waitFor(() =>
    expect(document.querySelectorAll(".log-row")).toHaveLength(2),
  );

  const stream = Stream.instances.at(-1)!;
  stream.emit("hello", { serverId: "server", clients: [client] });
  stream.emit("logs", { logs: [item(13)], clients: [client] });

  const older = document.querySelector<HTMLButtonElement>("#older")!;
  await vi.waitFor(() => expect(older.disabled).toBe(false));
  older.click();
  await vi.waitFor(() =>
    expect(document.querySelectorAll(".log-row")).toHaveLength(10),
  );
  expect(document.querySelector<HTMLElement>(".log-row")!.dataset.id).toBe("1");
  expect(document.querySelector("#notice")!.textContent).toContain("本地历史");

  // 实时日志也已旁路写入本地库
  const probe = createLocalHistory()!;
  probe.setServerId("server");
  const stored = await probe.page({ limit: 50, accept: () => true });
  expect(stored.logs.map((log) => log.id)).toContain(13);
  probe.dispose();
});
