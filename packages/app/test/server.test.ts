import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import { gzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import type { LogEvent, LogPage } from "@h5-log/sdk";
import { createLogServer, LogStore } from "../src/server/index.js";
import type { WorkbenchServiceStatus } from "../src/service-status.js";

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
    pageUrl: "https://h5.test/home?token=fake",
    level: "info",
    source: "console",
    args: ["hello", { token: "fake-token" }],
    ...extra,
  };
}
let app: ReturnType<typeof createLogServer>;
let origin: string;
beforeEach(async () => {
  app = createLogServer();
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
function post(events: LogEvent[]) {
  return fetch(`${origin}/api/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://h5.test" },
    body: JSON.stringify({ events }),
  });
}
async function page(params = "") {
  return (await (
    await fetch(`${origin}/api/logs?${params}`)
  ).json()) as LogPage;
}
async function subscriber() {
  const response = await fetch(`${origin}/api/stream`);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  async function next(name: string): Promise<string> {
    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (frame.startsWith(`event: ${name}\n`))
          return frame.split("\ndata: ")[1]!;
        continue;
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error("stream ended");
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  }
  await next("hello");
  return { next, close: () => reader.cancel() };
}

describe("日志服务的公开 HTTP/SSE 契约", () => {
  it("工作台状态共享采样快照，健康检查不返回宿主机指标", async () => {
    const status = async () => {
      const result = await fetch(`${origin}/api/status`, { headers: { Origin: "https://h5.test" } });
      expect(result.status).toBe(200);
      expect(result.headers.get("Cache-Control")).toBe("no-store");
      expect(result.headers.get("Access-Control-Allow-Origin")).toBeNull();
      return ((await result.json()) as WorkbenchServiceStatus).resources;
    };
    await expect.poll(async () => (await status()).sampledAt).toEqual(expect.any(Number));
    const samples = await Promise.all([status(), status(), status()]);
    expect(samples[0]).toEqual(samples[1]);
    expect(samples[1]).toEqual(samples[2]);
    const sample = samples[0]!;
    expect(sample.processCpu).toEqual({ current: null, peak: null });
    expect(sample.processMemory.current).toBeGreaterThan(0);
    expect(sample.processMemory.peak).toBe(sample.processMemory.current);
    const health = await (await fetch(`${origin}/api/health`)).json();
    expect(health).toMatchObject({ status: "ok" });
    expect(health).not.toHaveProperty("resources");
  });

  it("接受 gzip 上传并压缩查询响应，原始日志与预检头保持完整", async () => {
    const log = event({ args: ["完整正文".repeat(1500)] });
    const uploaded = await fetch(`${origin}/api/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Encoding": "gzip" },
      body: gzipSync(JSON.stringify({ events: [log] })),
    });
    expect(uploaded.status).toBe(202);
    const compressed = await fetch(`${origin}/api/logs`, { headers: { "Accept-Encoding": "gzip" } });
    expect(compressed.headers.get("Content-Encoding")).toBe("gzip");
    expect(compressed.headers.get("Vary")).toContain("Accept-Encoding");
    expect(((await compressed.json()) as LogPage).logs[0]!.args).toEqual(log.args);
    const plain = await fetch(`${origin}/api/logs`, { headers: { "Accept-Encoding": "gzip;q=0, *;q=1" } });
    expect(plain.headers.get("Content-Encoding")).toBeNull();
    expect(((await plain.json()) as LogPage).logs[0]!.args).toEqual(log.args);
    const preflight = await fetch(`${origin}/api/logs`, { method: "OPTIONS", headers: { Origin: "https://h5.test" } });
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain("Content-Encoding");
  });

  it("拒绝损坏、未知编码和解压超限的批次，不写入部分日志", async () => {
    for (const [encoding, body, status] of [
      ["gzip", Buffer.from("not-gzip"), 400],
      ["br", Buffer.from("{}"), 415],
      ["gzip", gzipSync("x".repeat(1024 * 1024 + 1)), 413],
      ["gzip", gzipSync("not-json"), 400],
    ] as const) {
      const result = await fetch(`${origin}/api/logs`, {
        method: "POST", headers: { "Content-Type": "application/json", "Content-Encoding": encoding }, body,
      });
      expect(result.status).toBe(status);
    }
    expect((await page()).logs).toHaveLength(0);
  });
  it("接收原始测试数据，重复上传不产生重复日志", async () => {
    const log = event();
    const response = await post([log]);
    expect(response.status).toBe(202);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await (await post([log])).json()).toEqual({ accepted: 0 });
    const result = await page();
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0]!.args).toEqual(log.args);
    expect(result.logs[0]!.pageUrl).toContain("token=fake");
    expect(result.clients).toHaveLength(1);
    expect(result.retentionHours).toBe(12);
  });

  it("布尔搜索在 HTTP 查询、分页和其他筛选中使用同一匹配规则", async () => {
    await post([
      event({ args: ["Bridge", { state: "token ready" }] }),
      event({ args: ["bridge token debug"] }),
      event({ args: ["bridge only"] }),
      event({ args: ["fallback"], source: "http", level: "error" }),
    ]);
    const search = "BRIDGE && token && -debug || fallback";
    const params = new URLSearchParams({ search, limit: "1" });
    const latest = await page(params.toString());
    expect(latest.logs.map((log) => log.args)).toEqual([["fallback"]]);
    expect(latest.total).toBe(2);
    expect(latest.hasMore).toBe(true);
    params.set("before", String(latest.logs[0]!.id));
    expect((await page(params.toString())).logs.map((log) => log.args)).toEqual([["Bridge", { state: "token ready" }]]);
    const filtered = await page(new URLSearchParams({ search, source: "console", level: "info" }).toString());
    expect(filtered.logs.map((log) => log.args)).toEqual([["Bridge", { state: "token ready" }]]);
    expect(filtered.total).toBe(1);
  });

  it("来源可按逗号分隔的并集筛选，单选和未指定来源仍保持原语义", async () => {
    await post([
      event({ source: "console" }),
      event({ source: "http" }),
      event({ source: "error", level: "error" }),
      event({ source: "custom" }),
    ]);
    const selected = await page("source=console%2Chttp");
    expect(selected.logs.map((log) => log.source)).toEqual(["console", "http"]);
    expect(selected.total).toBe(2);
    expect(selected.sessions[0]!.logCount).toBe(4);
    expect((await page("source=http")).logs.map((log) => log.source)).toEqual(["http"]);
    expect((await page()).logs).toHaveLength(4);
  });

  it("返回完整会话、总数和关联请求，不能跨客户端或会话串联", async () => {
    const request = event({
      source: "http",
      sessionId: "old",
      args: [
        {
          phase: "request",
          requestId: "same",
          method: "POST",
          url: "/order",
          body: { amount: 2 },
        },
      ],
    });
    const response = event({
      source: "http",
      sessionId: "old",
      args: [
        {
          phase: "response",
          requestId: "same",
          status: 200,
          body: { code: 1000 },
        },
      ],
    });
    const otherClient = event({
      source: "http",
      deviceId: "other",
      sessionId: "old",
      args: [{ phase: "response", requestId: "same" }],
    });
    const otherSession = event({
      source: "http",
      sessionId: "new",
      args: [{ phase: "response", requestId: "same" }],
    });
    await post([request, response, otherClient, otherSession]);
    const scoped = await page(
      `clientKey=${encodeURIComponent(JSON.stringify(["26", "test", "phone-a"]))}&sessionId=new&limit=1`,
    );
    expect(scoped.logs).toHaveLength(1);
    expect(scoped.total).toBe(1);
    expect(scoped.sessions.map((item) => item.sessionId)).toEqual([
      "new",
      "old",
    ]);
    const result = await (await fetch(`${origin}/api/logs/1`)).json();
    expect(result.log.eventId).toBe(request.eventId);
    expect(result.related.map((item: LogEvent) => item.eventId)).toEqual([
      response.eventId,
    ]);
    expect((await fetch(`${origin}/api/logs/999`)).status).toBe(404);
    const health = await (await fetch(`${origin}/api/health`)).json();
    expect(health).toMatchObject({
      status: "ok",
      logs: 4,
      clients: 2,
      sessions: 3,
      received: 4,
      evicted: 0,
      retentionHours: 12,
      limits: { maxLogs: 8000, maxSubscribers: 50 },
    });
  });

  it("应用、客户端、会话和筛选条件互不混淆，并可翻阅更早日志", async () => {
    await post([
      event({ args: ["first"], sessionId: "old" }),
      event({ args: ["second"], level: "warn" }),
      event({ deviceId: "phone-b", appId: "18", args: ["third"] }),
    ]);
    const scoped = await page("appId=26&limit=1");
    expect(scoped.logs[0]!.args).toEqual(["second"]);
    expect(scoped.hasMore).toBe(true);
    const earlier = await page(`appId=26&before=${scoped.logs[0]!.id}&limit=1`);
    expect(earlier.logs[0]!.args).toEqual(["first"]);
    expect((await page("level=warn")).logs).toHaveLength(1);
    expect((await page("sessionId=old")).logs).toHaveLength(1);
    expect((await page("search=THIRD")).logs[0]!.appId).toBe("18");
    expect((await page("after=3")).logs).toHaveLength(0);
  });

  it("同一批日志推送给多个查看者，关闭一个不影响另一个", async () => {
    const first = await subscriber();
    const second = await subscriber();
    const log = event();
    await post([log]);
    const a = JSON.parse(await first.next("logs")) as { logs: LogEvent[] };
    const b = JSON.parse(await second.next("logs")) as { logs: LogEvent[] };
    expect(a.logs[0]!.eventId).toBe(log.eventId);
    expect(b.logs[0]!.eventId).toBe(log.eventId);
    await first.close();
    await post([event({ args: ["still connected"] })]);
    expect(JSON.parse(await second.next("logs")).logs[0].args).toEqual([
      "still connected",
    ]);
    await second.close();
  });

  it("重连后仍可读取保留日志，无需手机重新发送", async () => {
    const viewer = await subscriber();
    await viewer.close();
    await post([event({ args: ["viewer was offline"] })]);
    const reconnected = await subscriber();
    expect((await page()).logs[0]!.args).toEqual(["viewer was offline"]);
    await reconnected.close();
  });

  it("拒绝无效和超大数据，整批校验失败时不写入部分日志", async () => {
    expect(
      (await post([event(), event({ level: "invalid" as LogEvent["level"] })]))
        .status,
    ).toBe(400);
    expect(
      (await post([event(), event({ source: "bridge" as LogEvent["source"] })]))
        .status,
    ).toBe(400);
    expect((await page()).logs).toHaveLength(0);
    expect(
      (await post([event({ args: ["a".repeat(129 * 1024)] })])).status,
    ).toBe(413);
    const response = await fetch(`${origin}/api/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "a".repeat(1024 * 1024 + 1),
    });
    expect(response.status).toBe(413);
    expect(
      (
        await fetch(`${origin}/api/logs`, {
          method: "POST",
          body: "plain text",
        })
      ).status,
    ).toBe(415);
    expect((await fetch(`${origin}/api/logs?before=NaN`)).status).toBe(400);
  });

  it("分块请求超过限制时返回明确的 413", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        `${origin}/api/logs`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Transfer-Encoding": "chunked",
          },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      );
      request.on("error", reject);
      request.write("a".repeat(600 * 1024));
      request.end("b".repeat(600 * 1024));
    });
    expect(status).toBe(413);
  });
});

describe("设备目录", () => {
  it("相同 GAID 的多次采集归入同一设备，不按页面会话新增选项", () => {
    const store = new LogStore();
    store.add([event({ deviceId: "gaid-a", sessionId: "first", deviceName: "SM-A156U" })]);
    store.add([event({ deviceId: "gaid-a", sessionId: "reopened", deviceName: "SM-A156U" })]);

    expect(store.clients()).toEqual([expect.objectContaining({
      deviceId: "gaid-a", deviceName: "SM-A156U", sessionId: "reopened", logCount: 2,
    })]);
  });

  it("只给同型号的不同设备编号，跨应用复用且不随最近上报排序变化", () => {
    let now = 1000;
    const store = new LogStore({ now: () => now });
    store.add([event({ deviceId: "gaid-a", deviceName: "SM-A156U" })]);
    now++;
    store.add([event({ deviceId: "gaid-b", deviceName: "SM-A156U" })]);
    now++;
    store.add([
      event({ appId: "18", deviceId: "gaid-a", deviceName: "SM-A156U" }),
      event({ environment: "dev", deviceId: "gaid-b", deviceName: "SM-A156U" }),
      event({ deviceId: "gaid-c", deviceName: "moto g24" }),
    ]);
    const names = () => store.clients().map(({ key, deviceName }) => [key, deviceName]).sort();
    const initialNames = names();
    expect(store.clients().filter(({ deviceId }) => deviceId === "gaid-a"))
      .toEqual([expect.objectContaining({ deviceName: "SM-A156U-1" }), expect.objectContaining({ deviceName: "SM-A156U-1" })]);
    expect(store.clients().filter(({ deviceId }) => deviceId === "gaid-b"))
      .toEqual([expect.objectContaining({ deviceName: "SM-A156U-2" }), expect.objectContaining({ deviceName: "SM-A156U-2" })]);
    expect(store.clients().find(({ deviceId }) => deviceId === "gaid-c")?.deviceName).toBe("moto g24");

    now++;
    store.add([event({ deviceId: "gaid-a", deviceName: "SM-A156U" })]);
    expect(store.clients()[0]?.deviceId).toBe("gaid-a");
    expect(names()).toEqual(initialNames);
    now++;
    store.add([event({ deviceId: "gaid-d", deviceName: "SM-A156U" })]);
    expect(store.clients().find(({ deviceId }) => deviceId === "gaid-d")?.deviceName).toBe("SM-A156U-3");
  });

  it("相同设备在不同应用上报时不被误当成同型号的多台手机", () => {
    const store = new LogStore();
    store.add([
      event({ appId: "18", deviceId: "gaid-a", deviceName: "SM-A156U" }),
      event({ appId: "26", deviceId: "gaid-a", deviceName: "SM-A156U" }),
    ]);
    expect(store.clients().map(({ deviceName }) => deviceName)).toEqual(["SM-A156U", "SM-A156U"]);
  });
});

describe("12 小时与内存淘汰规则", () => {
  it("以服务端接收时间过期，不受手机时钟影响，达到 12 小时清理", () => {
    let now = 100;
    const store = new LogStore({ now: () => now });
    store.add([event({ timestamp: Date.now() + 10 ** 12 })]);
    now += 12 * 60 * 60 * 1000 - 1;
    expect(store.page().logs).toHaveLength(1);
    now++;
    expect(store.page().logs).toHaveLength(0);
    expect(store.clients()).toHaveLength(0);
  });

  it("保留时长可配置，按传入小时数过期", () => {
    let now = 0;
    const store = new LogStore({ now: () => now, retentionHours: 1 });
    store.add([event()]);
    now = 60 * 60 * 1000 - 1;
    expect(store.page().logs).toHaveLength(1);
    now++;
    expect(store.page().logs).toHaveLength(0);
    expect(store.page().retentionHours).toBe(1);
  });

  it("容量不足时先淘汰最旧记录，并清理相关客户端", () => {
    const store = new LogStore({ maxLogs: 2 });
    store.add([
      event({ deviceId: "old", args: ["old"] }),
      event({ deviceId: "new", args: ["second"] }),
      event({ deviceId: "new", args: ["third"] }),
    ]);
    expect(store.page().logs.map((log) => log.args[0])).toEqual([
      "second",
      "third",
    ]);
    expect(store.clients().map((client) => client.deviceId)).toEqual(["new"]);
    const bytes = new LogStore({ maxBytes: 1024 });
    bytes.add([event(), event(), event(), event()]);
    expect(bytes.stats().bytes).toBeLessThanOrEqual(1024);
  });

  it("工作台可申请 2000 条日志，超出请求仍按上限分页", () => {
    const store = new LogStore();
    store.add(Array.from({ length: 2001 }, (_, index) => event({ args: [index] })));
    expect(store.page().logs).toHaveLength(200);
    const latest = store.page({ limit: 5000 });
    expect(latest.logs).toHaveLength(2000);
    expect(latest.logs[0]?.id).toBe(2);
    expect(latest.hasMore).toBe(true);
    expect(store.page({ before: 2, limit: 2000 }).logs.map((log) => log.id)).toEqual([1]);
  });

  it("历史页的匹配总数不受 before 分页游标影响", () => {
    const store = new LogStore();
    store.add(
      Array.from({ length: 5 }, (_, i) => event({ args: [`entry-${i}`] })),
    );
    const page = store.page({ before: 4, limit: 2 });
    expect(page.logs.map((log) => log.id)).toEqual([2, 3]);
    expect(page.total).toBe(5);
    expect(page.hasMore).toBe(true);
  });

  it("过期日志去重键先清理，允许相同事件在新保留窗口写入", () => {
    let now = 0;
    const store = new LogStore({ now: () => now });
    const log = event();
    store.add([log]);
    now = 12 * 60 * 60 * 1000;
    expect(store.add([log])).toHaveLength(1);
    expect(store.page().logs).toHaveLength(1);
    expect(store.stats()).toMatchObject({ received: 2, evicted: 1 });
  });

  it("容量淘汰后立即解除旧日志数组引用", () => {
    const store = new LogStore({ maxLogs: 2 });
    store.add([
      event({ args: ["first"] }),
      event({ args: ["second"] }),
      event({ args: ["third"] }),
    ]);
    const entries = (store as unknown as { entries: (object | undefined)[] })
      .entries;
    expect(entries.filter(Boolean)).toHaveLength(2);
    expect(entries[0]).toBeUndefined();
    expect(store.stats()).toMatchObject({
      logs: 2,
      bytes: store
        .page()
        .logs.reduce(
          (sum, item) => sum + Buffer.byteLength(JSON.stringify(item)),
          0,
        ),
    });
  });

  it("新的服务实例没有历史内存记录，实例标识发生变化", () => {
    const first = new LogStore();
    first.add([event()]);
    const second = new LogStore();
    expect(second.page().logs).toHaveLength(0);
    expect(second.serverId).not.toBe(first.serverId);
  });
});
