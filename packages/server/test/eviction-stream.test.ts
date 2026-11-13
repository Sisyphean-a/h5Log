import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { ClientUpdate, LogEvent, LogPage } from "@h5-log/sdk";
import { createLogServer, LogStore } from "../src/index.js";

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
async function stream() {
  const response = await fetch(`${origin}/api/stream`);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  async function next(name: string): Promise<any> {
    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (frame.startsWith(`event: ${name}\n`))
          return JSON.parse(frame.split("\ndata: ")[1]!);
        continue;
      }
      const result = await reader.read();
      if (result.done) throw new Error("stream ended");
      buffer += decoder.decode(result.value, { stream: true });
    }
  }
  await next("hello");
  return { next, close: () => reader.cancel() };
}
async function post(events: LogEvent[]) {
  return fetch(`${origin}/api/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events }),
  });
}

describe("容量淘汰通知", () => {
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
    await viewer.next("clients");
    await post([second]);
    await viewer.next("logs");
    await viewer.next("clients");
    await post([third]);
    await viewer.next("logs");
    const update = (await viewer.next("clients")) as ClientUpdate;
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
