import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { ClientUpdate, LogEvent, LogPage } from "@h5-log/sdk";
import { createLogServer, LogStore } from "../src/server/index.js";

function event(extra: Partial<LogEvent> = {}): LogEvent {
  return {
    eventId: crypto.randomUUID(),
    appId: "26",
    environment: "test",
    deviceId: "phone-a",
    sessionId: "session-a",
    deviceName: "测试手机",
    userAgent: "WebView",
    timestamp: Date.now(),
    pageUrl: "https://h5.test",
    level: "info",
    source: "console",
    args: ["hello"],
    ...extra,
  };
}
let app: ReturnType<typeof createLogServer>;
let origin: string;
beforeEach(async () => {
  app = createLogServer({ store: new LogStore({ maxLogs: 2 }) });
  await new Promise<void>((resolve) =>
    app.server.listen(0, "127.0.0.1", resolve),
  );
  origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  app.closeStreams();
  app.server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    app.server.close((error) => (error ? reject(error) : resolve())),
  );
});
async function stream(query = "", encoding = "gzip") {
  const response = await fetch(`${origin}/api/stream${query}`, { headers: { "Accept-Encoding": encoding } });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  async function next(name?: string): Promise<any> {
    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (frame.startsWith("event: ")) {
          const type = frame.slice(7, frame.indexOf("\n"));
          const data = JSON.parse(frame.split("\ndata: ")[1]!);
          if (!name) return { type, data };
          if (type === name) return data;
        }
        continue;
      }
      const result = await reader.read();
      if (result.done) throw new Error("stream ended");
      buffer += decoder.decode(result.value, { stream: true });
    }
  }
  await next("hello");
  return { next, response, close: () => reader.cancel() };
}
async function post(events: LogEvent[]) {
  return fetch(`${origin}/api/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events }),
  });
}

describe("实时分发与容量淘汰通知", () => {
  it("按设备只发送该设备正文，仍发送全局目录，压缩流立即可读", async () => {
    const key = encodeURIComponent(JSON.stringify(["26", "test", "phone-a"]));
    const selected = await stream(`?clientKey=${key}`);
    const other = await stream("?clientKey=not-selected", "identity");
    expect(selected.response.headers.get("Content-Encoding")).toBe("gzip");
    expect(other.response.headers.get("Content-Encoding")).toBeNull();
    await post([event({ eventId: "selected" }), event({ deviceId: "phone-b", eventId: "other" })]);
    const batch = await selected.next();
    expect(batch.type).toBe("logs");
    expect(batch.data.logs.map((log: LogEvent) => log.eventId)).toEqual(["selected"]);
    expect(batch.data.clients).toHaveLength(2);
    expect(batch.data.evictedThroughId).toBe(0);
    expect((await other.next()).type).toBe("clients");
    await post([event({ deviceId: "phone-b" })]);
    const directory = await selected.next();
    expect(directory.type).toBe("clients");
    expect(directory.data.evictedThroughId).toBe(1);
    await selected.close();
    await other.close();
  });

  it("订阅范围支持应用和环境，不把阅读筛选混入采集范围", async () => {
    const viewer = await stream("?appId=26&environment=test&level=error&search=missing");
    await post([event({ eventId: "matched" }), event({ appId: "18", eventId: "other-app" })]);
    expect((await viewer.next("logs")).logs.map((log: LogEvent) => log.eventId)).toEqual(["matched"]);
    await viewer.close();
  });
  it("通知已连接查看者清理被容量淘汰的正文和会话", async () => {
    const viewer = await stream();
    const first = event({
      eventId: "first",
      deviceId: "old",
      sessionId: "old-session",
    });
    const second = event({
      eventId: "second",
      deviceId: "new",
      sessionId: "new-session",
    });
    const third = event({
      eventId: "third",
      deviceId: "new",
      sessionId: "new-session",
    });
    await post([first]);
    await viewer.next("logs");
    await post([second]);
    await viewer.next("logs");
    await post([third]);
    const update = (await viewer.next("logs")) as ClientUpdate;
    expect(update.evictedThroughId).toBe(1);
    expect(update.clients.map((client) => client.deviceId)).toEqual(["new"]);
    const page = (await (await fetch(`${origin}/api/logs`)).json()) as LogPage;
    expect(page.logs.map((log) => log.eventId)).toEqual(["second", "third"]);
    expect(page.sessions.map((session) => session.sessionId)).toEqual([
      "new-session",
    ]);
    await viewer.close();
  });
});
