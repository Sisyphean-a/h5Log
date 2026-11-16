import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LogClient, LogPage, LogSession, StoredLog } from "@h5-log/sdk";
import { createWorkbench, type FilterState } from "../src/web/workbench.js";
import { createLocalHistory, type LocalHistory } from "../src/web/history.js";
import { LogStore } from "../src/server/store.js";

const client: LogClient = {
  key: "client-a",
  appId: "26",
  environment: "test",
  deviceId: "phone-a",
  sessionId: "session-a",
  deviceName: "测试手机",
  userAgent: "WebView",
  lastSeen: Date.now(),
  logCount: 10,
  errorCount: 0,
};

function log(id: number, level: StoredLog["level"] = "info"): StoredLog {
  return {
    id,
    appId: "26",
    environment: "test",
    deviceId: "phone-a",
    sessionId: "session-a",
    deviceName: "测试手机",
    userAgent: "WebView",
    pageUrl: "https://h5.test/home",
    timestamp: 1700000000000 + id,
    level,
    source: "console",
    args: [`entry-${id}`],
    receivedAt: 1700000000000 + id,
    clientKey: "client-a",
    eventId: `evt-${id}`,
  };
}

function httpLog(
  id: number,
  phase: "request" | "response",
  requestId: string,
): StoredLog {
  return {
    ...log(id),
    source: "http",
    args: [{ phase, requestId, method: "POST", url: "/api/order", status: 200 }],
  };
}

function session(overrides: Partial<LogSession> = {}): LogSession {
  return {
    clientKey: "client-a",
    sessionId: "session-a",
    firstSeen: 1700000000000,
    lastSeen: 1700000000000,
    logCount: 1,
    errorCount: 0,
    pageUrl: "https://h5.test/home",
    ...overrides,
  };
}

function page(logs: StoredLog[], cursor: number, extra: Partial<LogPage> = {}): LogPage {
  return {
    logs,
    clients: [client],
    sessions: [session()],
    cursor,
    hasMore: false,
    total: logs.length,
    retentionHours: 12,
    serverId: "server-a",
    ...extra,
  };
}

function response(body: LogPage | unknown) {
  return { ok: true, json: async () => body } as unknown as Response;
}

class Stream extends EventTarget {
  close = vi.fn();

  emit(name: string, data: unknown): void {
    this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) }));
  }
}

let workbench: ReturnType<typeof createWorkbench> | undefined;
let history: LocalHistory | undefined;

afterEach(() => {
  workbench?.dispose();
  history?.dispose();
  workbench = undefined;
  history = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("工作台状态", () => {
  it("无关的全局淘汰不触发当前设备的列表或索引查询", async () => {
    const fetchImpl = vi.fn();
    workbench = createWorkbench({ fetchImpl });
    workbench.state.filter.clientKey = client.key;
    workbench.state.logs = [log(100)];
    workbench.state.sessions = [session()];
    for (let id = 1; id <= 5; id++) {
      workbench.handleClients({ clients: [{ ...client, logCount: 1 }], expiresBefore: 0, evictedThroughId: id });
    }
    await Promise.resolve();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(workbench.state.logs.map((item) => item.id)).toEqual([100]);
  });

  it("当前页被淘汰时只补读一份列表，复用其中的会话索引", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(page([log(2)], 2)));
    workbench = createWorkbench({ fetchImpl });
    workbench.state.logs = [log(1), log(2)];
    workbench.state.sessions = [session({ logCount: 2 })];
    workbench.handleClients({ clients: [{ ...client, logCount: 1 }], expiresBefore: 0, evictedThroughId: 1 });
    await vi.waitFor(() => expect(workbench!.state.loading).toBe(false));
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(new URL(String(fetchImpl.mock.calls[0]![0]), "http://localhost").searchParams.get("limit")).toBe("200");
    expect(workbench.state.logs.map((item) => item.id)).toEqual([2]);
  });

  it("当前页未受影响但会话计数变化时，只合并刷新索引", async () => {
    let finish!: (value: Response) => void;
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
      .mockResolvedValue(response(page([log(100)], 100, { sessions: [session({ logCount: 9 })] })));
    workbench = createWorkbench({ fetchImpl });
    workbench.state.logs = [log(100)];
    workbench.state.sessions = [session({ logCount: 10 })];
    for (let id = 1; id <= 5; id++) {
      workbench.handleClients({ clients: [{ ...client, logCount: 9 }], expiresBefore: 0, evictedThroughId: id });
    }
    expect(fetchImpl).toHaveBeenCalledOnce();
    finish(response(page([log(100)], 100, { sessions: [session({ logCount: 9 })] })));
    await workbench.refreshSessions();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.every(([url]) => new URL(String(url), "http://localhost").searchParams.get("limit") === "1")).toBe(true);
    expect(workbench.state.sessions[0]!.logCount).toBe(9);
    expect(workbench.state.logs.map((item) => item.id)).toEqual([100]);
  });

  it("索引读取期间的新事件不被迟到索引覆盖，下一次合并读取收敛", async () => {
    let finish!: (value: Response) => void;
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
      .mockResolvedValue(response(page([log(2)], 2, { sessions: [session({ logCount: 2 })] })));
    workbench = createWorkbench({ fetchImpl });
    workbench.state.logs = [log(1)];
    workbench.state.sessions = [session()];
    workbench.state.cursor = 1;
    const reading = workbench.refreshSessions();
    workbench.handleLogs({ logs: [log(2)], clients: [{ ...client, logCount: 2 }] });
    finish(response(page([log(1)], 1)));
    await reading;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(workbench.state.sessions[0]!.logCount).toBe(2);
  });

  it("索引快照已计入但尚未推送的事件不重复累加会话", async () => {
    workbench = createWorkbench({ fetchImpl: vi.fn().mockResolvedValue(response(page([log(2)], 2, { sessions: [session({ logCount: 2 })] }))) });
    workbench.state.logs = [log(1)];
    workbench.state.sessions = [session()];
    workbench.state.cursor = 1;
    await workbench.refreshSessions();
    workbench.handleLogs({ logs: [log(2)], clients: [{ ...client, logCount: 2 }] });
    expect(workbench.state.sessions[0]!.logCount).toBe(2);
    expect(workbench.state.logs.map((item) => item.id)).toEqual([1, 2]);
  });

  it("列表请求期间无关淘汰不重复补读，响应内确有淘汰行才再补一次", async () => {
    let finish!: (value: Response) => void;
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
      .mockResolvedValue(response(page([log(100)], 100)));
    workbench = createWorkbench({ fetchImpl });
    workbench.state.logs = [log(100)];
    workbench.state.sessions = [session()];
    const first = workbench.load();
    workbench.handleClients({ clients: [{ ...client, logCount: 1 }], expiresBefore: 0, evictedThroughId: 1 });
    finish(response(page([log(100)], 100)));
    await first;
    expect(fetchImpl).toHaveBeenCalledOnce();
    fetchImpl.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const second = workbench.load();
    workbench.handleClients({ clients: [{ ...client, logCount: 1 }], expiresBefore: 0, evictedThroughId: 2 });
    finish(response(page([log(2), log(100)], 100)));
    await second;
    await vi.waitFor(() => expect(workbench!.state.loading).toBe(false));
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(workbench.state.logs.map((item) => item.id)).toEqual([100]);
  });
  it("静默连接超过三个心跳周期后重建，hello 补读且忽略旧流", async () => {
    vi.useFakeTimers();
    const streams: Stream[] = [];
    const fetchImpl = vi.fn().mockResolvedValue(response(page([log(2)], 2)));
    workbench = createWorkbench({
      fetchImpl,
      openStream: () => { const stream = new Stream(); streams.push(stream); return stream; },
    });
    workbench.connect();
    streams[0]!.emit("hello", { serverId: "server-a", clients: [client] });
    await vi.advanceTimersByTimeAsync(44999);
    expect(streams).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(streams[0]!.close).toHaveBeenCalledOnce();
    expect(streams).toHaveLength(2);
    expect(workbench.state.connection).toBe("connecting");
    streams[1]!.emit("hello", { serverId: "server-a", clients: [client] });
    await vi.advanceTimersByTimeAsync(0);
    expect(workbench.state.connection).toBe("open");
    expect(workbench.state.logs.map((item) => item.id)).toEqual([2]);
    streams[0]!.emit("logs", { logs: [log(99)], clients: [client] });
    expect(workbench.state.logs.map((item) => item.id)).toEqual([2]);
    workbench.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("补读请求或响应正文挂起会超时，失败仍保留期间的实时增量", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({ ok: true, json: () => new Promise(() => {}) })
      .mockResolvedValue(response(page([log(3)], 3)));
    workbench = createWorkbench({ fetchImpl });
    workbench.state.logs = [log(1)];
    const first = workbench.load();
    workbench.handleLogs({ logs: [log(2)], clients: [client] });
    await vi.advanceTimersByTimeAsync(10000);
    await first;
    expect(workbench.state.loading).toBe(false);
    expect(workbench.state.error).toContain("超时");
    expect(workbench.state.logs.map((item) => item.id)).toEqual([1, 2]);
    const second = workbench.load();
    await vi.advanceTimersByTimeAsync(10000);
    await second;
    expect(workbench.state.loading).toBe(false);
    await workbench.load();
    expect(workbench.state.logs.map((item) => item.id)).toEqual([3]);
  });

  it("无新日志但目录心跳持续时不重连，暂存后停止检测", async () => {
    vi.useFakeTimers();
    const stream = new Stream();
    const openStream = vi.fn(() => stream);
    workbench = createWorkbench({ openStream });
    workbench.connect();
    stream.emit("hello", { serverId: "server-a", clients: [client] });
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(15000);
      stream.emit("clients", { clients: [client], expiresBefore: 0, evictedThroughId: 0 });
    }
    expect(openStream).toHaveBeenCalledOnce();
    workbench.suspend();
    await vi.advanceTimersByTimeAsync(90000);
    expect(openStream).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("实时订阅跟随设备范围，但不按关键词级别或会话截断本地历史", async () => {
    const streams: Stream[] = [];
    const openStream = vi.fn((_url: string) => {
      const stream = new Stream(); streams.push(stream); return stream;
    });
    workbench = createWorkbench({ openStream, fetchImpl: vi.fn().mockResolvedValue(response(page([], 0))) });
    workbench.connect();
    workbench.setScope({ clientKey: "client-a", appId: "26", environment: "test" });
    const url = new URL(openStream.mock.calls.at(-1)![0], "http://localhost");
    expect(url.searchParams.get("clientKey")).toBe("client-a");
    expect(url.searchParams.get("appId")).toBe("26");
    expect(url.searchParams.get("environment")).toBe("test");
    expect(streams[0]!.close).toHaveBeenCalledOnce();
    const count = openStream.mock.calls.length;
    workbench.setFilter({ search: "hello", level: "error", sessionId: "session-a" });
    expect(openStream).toHaveBeenCalledTimes(count);
  });
  it("子路径下列表、详情、状态和实时流都使用同一前缀", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) =>
      response(String(url).includes("logs/1") ? { log: log(1), related: [] } : page([log(1)], 1)),
    );
    const openStream = vi.fn((_url: string) => new Stream());
    workbench = createWorkbench({ fetchImpl, openStream });
    await workbench.load();
    await workbench.openDetail(1);
    await workbench.loadService();
    await workbench.refreshSessions();
    workbench.connect();
    const base = "https://example.test/h5-log/";
    const paths = fetchImpl.mock.calls.map(([url]) => new URL(String(url), base).pathname);
    expect(paths).toEqual(["/h5-log/api/logs", "/h5-log/api/logs/1", "/h5-log/api/health", "/h5-log/api/logs"]);
    expect(new URL(openStream.mock.calls[0]![0], base).pathname).toBe("/h5-log/api/stream");
  });

  it("暂存后恢复当前历史页，忽略旧连接和迟到响应，最终销毁后不再恢复", async () => {
    let finish!: (value: Response) => void;
    const streams: Stream[] = [];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(page([log(10)], 10, { hasMore: true })))
      .mockResolvedValueOnce(response(page([log(5)], 10)))
      .mockImplementationOnce(
        () => new Promise<Response>((resolve) => { finish = resolve; }),
      )
      .mockResolvedValue(response(page([log(6)], 12)));
    workbench = createWorkbench({
      fetchImpl,
      openStream: () => {
        const stream = new Stream();
        streams.push(stream);
        return stream;
      },
    });
    workbench.connect();
    await workbench.load();
    await workbench.loadOlder();
    const stale = workbench.load(10);
    workbench.suspend();
    expect(streams[0]!.close).toHaveBeenCalledOnce();
    expect(workbench.state.loading).toBe(false);

    workbench.resume();
    await vi.waitFor(() =>
      expect(workbench!.state.logs.map((item) => item.id)).toEqual([6]),
    );
    expect(String(fetchImpl.mock.calls[3]![0])).toContain("before=10");
    finish(response(page([log(4)], 11)));
    await stale;
    streams[0]!.emit("logs", { logs: [log(99)], clients: [client] });
    expect(workbench.state.logs.map((item) => item.id)).toEqual([6]);
    expect(workbench.state.loading).toBe(false);

    workbench.dispose();
    workbench.resume();
    workbench.connect();
    await workbench.load();
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(streams).toHaveLength(2);
    expect(streams[1]!.close).toHaveBeenCalledOnce();
  });

  it.each(["appId", "environment", "clientKey"] as const)(
    "%s 范围在快照、两种实时状态和本地历史中一致，会话统计不受日志筛选影响",
    async (scope) => {
      const now = Date.now();
      const store = new LogStore({ now: () => now });
      const seed = store.add([{ ...log(1), args: ["订单"] }])[0]!;
      const filter: Partial<FilterState> = {
        [scope]: seed[scope],
        sessionId: seed.sessionId,
        level: "info",
        source: "console",
        search: " 订单 ",
      };
      const snapshot = store.page(filter);
      const outside = scope === "appId"
        ? { appId: "other-app" }
        : scope === "environment"
          ? { environment: "other-environment" }
          : { deviceId: "other-device" };
      let finish!: (value: Response) => void;
      const stream = new Stream();
      history = createLocalHistory()!;
      workbench = createWorkbench({
        history,
        openStream: () => stream,
        fetchImpl: vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })),
      });
      workbench.connect();
      workbench.setFilter(filter);
      stream.emit("logs", {
        logs: store.add([{ ...log(2), ...outside, args: ["订单"] }]),
        clients: store.clients(),
      });
      finish(response(snapshot));
      await vi.waitFor(() => expect(workbench!.state.loading).toBe(false));

      const incoming = store.add([
        { ...log(3), ...outside, args: ["订单"] },
        { ...log(4), sessionId: "other-session", level: "error", source: "http", args: ["其他内容"] },
        { ...log(5), args: ["订单"] },
      ]);
      stream.emit("logs", { logs: incoming, clients: store.clients() });
      const expected = store.page(filter);
      const counts = (sessions: LogSession[]) => new Map(sessions.map((session) => [
        JSON.stringify([session.clientKey, session.sessionId]),
        { logs: session.logCount, errors: session.errorCount },
      ]));
      expect(workbench.state.logs).toEqual(expected.logs);
      expect(workbench.state.total).toBe(expected.total);
      expect(counts(workbench.state.sessions)).toEqual(counts(expected.sessions));
      expect(workbench.state.sessions).toHaveLength(2);
      expect(workbench.state.cursor).toBe(expected.cursor);

      await workbench.loadLocal(100);
      expect(workbench.state.localMode).toBe(true);
      expect(workbench.state.logs).toEqual(expected.logs);
      workbench.suspend();
      workbench.resume();
      await vi.waitFor(() => expect(workbench!.state.loading).toBe(false));
      expect(workbench.state.localMode).toBe(true);
      expect(workbench.state.logs).toEqual(expected.logs);
    },
  );

  it("来源并集在查询、实时增量与本地历史中一致，清空后不限来源", async () => {
    const store = new LogStore();
    store.add([
      log(1),
      httpLog(2, "request", "request-a"),
      { ...log(3, "error"), source: "error" },
      { ...log(4), source: "custom" },
    ]);
    const snapshot = store.page({});
    history = createLocalHistory()!;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const params = new URL(String(input), "http://localhost").searchParams;
      return response(store.page({ source: params.get("source") ?? "" }));
    });
    workbench = createWorkbench({ history, fetchImpl });
    workbench.handleHello({ serverId: snapshot.serverId, clients: snapshot.clients });
    workbench.setFilter({ source: "console,http" });
    await vi.waitFor(() => expect(workbench!.state.loading).toBe(false));
    expect(workbench.state.logs.map((item) => item.source)).toEqual(["console", "http"]);

    const incoming = store.add([
      log(5),
      httpLog(6, "response", "request-a"),
      { ...log(7, "error"), source: "error" },
    ]);
    workbench.handleLogs({ logs: incoming, clients: store.clients() });
    const expected = store.page({ source: "console,http" }).logs;
    expect(workbench.state.logs).toEqual(expected);
    await workbench.loadLocal(100);
    expect(workbench.state.logs).toEqual(expected);

    workbench.setFilter({ source: "" });
    await vi.waitFor(() => expect(workbench!.state.loading).toBe(false));
    expect(workbench.state.logs).toEqual(store.page({}).logs);
    expect(new URL(String(fetchImpl.mock.calls.at(-1)![0]), "http://localhost").searchParams.has("source")).toBe(false);
  });

  it("快照游标内的迟到事件不计入会话，新事件只计一次", async () => {
    const workbench = createWorkbench({
      fetchImpl: vi.fn().mockResolvedValue(response(page([log(10, "error")], 10))),
    });
    workbench.handleHello({ serverId: "server-a", clients: [client] });
    await workbench.load();
    expect(workbench.state.logs.map((item) => item.id)).toEqual([10]);

    workbench.handleLogs({ logs: [log(9)], clients: [client] });
    expect(workbench.state.sessions[0]!.logCount).toBe(1);

    workbench.handleLogs({ logs: [log(11)], clients: [client] });
    expect(workbench.state.sessions[0]!.logCount).toBe(2);

    workbench.handleLogs({ logs: [log(11)], clients: [client] });
    expect(workbench.state.sessions[0]!.logCount).toBe(2);
    expect(workbench.state.logs.map((item) => item.id)).toEqual([10, 11]);
  });

  it("本地历史页不受服务端容量水位和过期窗口清空", async () => {
    const now = Date.now();
    history = createLocalHistory()!;
    history.setServerId("server-a");
    await history.clear();
    history.append([1, 2].map((id) => ({ ...log(id), receivedAt: now - 13 * 3600000 })));
    const current = [20, 21].map((id) => ({ ...log(id), receivedAt: now }));
    const fetchImpl = vi.fn().mockResolvedValue(response(page(current, 21)));
    workbench = createWorkbench({ fetchImpl, history });
    await workbench.load();
    workbench.handleClients({ clients: [client], expiresBefore: 0, evictedThroughId: 10 });
    await vi.waitFor(() => expect(workbench!.state.loading).toBe(false));
    await workbench.loadOlder();
    expect(workbench.state.localMode).toBe(true);
    expect(workbench.state.logs.map((item) => item.id)).toEqual([1, 2]);
    workbench.state.selectedId = 1;
    const requests = fetchImpl.mock.calls.length;

    workbench.handleClients({ clients: [client], expiresBefore: now - 12 * 3600000, evictedThroughId: 10 });
    expect(workbench.state.logs.map((item) => item.id)).toEqual([1, 2]);
    expect(workbench.state.localMode).toBe(true);
    expect(workbench.state.selectedId).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(requests);
  });

  it("更早的服务端页为空时保留当前页，并补上加载期间的新日志", async () => {
    let finish!: (value: Response) => void;
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(page([log(10)], 10, { hasMore: true })))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
      .mockResolvedValue(response(page([log(10), log(11)], 11)));
    workbench = createWorkbench({ fetchImpl, openStream: () => new Stream() });
    await workbench.load();
    const older = workbench.loadOlder();
    workbench.handleLogs({ logs: [log(11)], clients: [client] });
    finish(response(page([], 11, { total: 2 })));
    await older;
    expect(workbench.state.logs.map((item) => item.id)).toEqual([10, 11]);
    expect(workbench.state.total).toBe(2);
    expect(workbench.state.serverHasMore).toBe(false);
    workbench.suspend();
    workbench.resume();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));
    expect(new URL(String(fetchImpl.mock.calls[2]![0]), "http://localhost").searchParams.has("before")).toBe(false);
  });

  it("读更早时遇到服务重启，不保留旧实例记录或旧分页游标", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response(page([log(10)], 10, { hasMore: true })))
      .mockResolvedValue(response(page([], 0, { serverId: "server-b" })));
    workbench = createWorkbench({ fetchImpl });
    await workbench.load();
    await workbench.loadOlder();
    await vi.waitFor(() => expect(workbench!.state.loading).toBe(false));
    expect(workbench.state.serverId).toBe("server-b");
    expect(workbench.state.logs).toHaveLength(0);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(new URL(String(fetchImpl.mock.calls[2]![0]), "http://localhost").searchParams.has("before")).toBe(false);
  });

  it("实时窗口裁掉旧行后，仍可通过更早读取它们", async () => {
    workbench = createWorkbench({ fetchImpl: vi.fn().mockResolvedValue(response(page([log(1)], 1))) });
    await workbench.load();
    expect(workbench.state.serverHasMore).toBe(false);
    workbench.handleLogs({ logs: Array.from({ length: 200 }, (_, index) => log(index + 2)), clients: [client] });
    expect(workbench.state.logs).toHaveLength(200);
    expect(workbench.state.serverHasMore).toBe(true);
  });

  it("容量淘汰通知清理行与会话，并让详情关闭", async () => {
    const workbench = createWorkbench({
      fetchImpl: vi
        .fn()
        .mockResolvedValue(response(page([log(10), log(11)], 11))),
    });
    workbench.handleHello({ serverId: "server-a", clients: [client] });
    await workbench.load();
    await workbench.openDetail(10);
    workbench.handleClients({
      clients: [client],
      expiresBefore: 0,
      evictedThroughId: 10,
    });
    expect(workbench.state.logs.map((item) => item.id)).toEqual([11]);
    expect(workbench.state.selectedId).toBeUndefined();
  });

  it("清空视图使用全局游标，旧日志不会回到列表", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(page([log(10), log(11)], 11)))
      .mockResolvedValue(response(page([], 11, { total: 2 })));
    const workbench = createWorkbench({ fetchImpl });
    workbench.handleHello({ serverId: "server-a", clients: [client] });
    await workbench.load();
    workbench.clearView();
    expect(workbench.state.clearAfter).toBe(11);
    expect(workbench.state.logs).toHaveLength(0);
    workbench.handleLogs({ logs: [log(9), log(12)], clients: [client] });
    expect(workbench.state.logs.map((item) => item.id)).toEqual([12]);
  });

  it("加载期间的新事件进入缓冲，快照返回后按游标合并且不重复", async () => {
    let finish!: (value: Response) => void;
    const workbench = createWorkbench({
      fetchImpl: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        )
        .mockResolvedValue(response(page([log(10)], 10))),
    });
    workbench.handleHello({ serverId: "server-a", clients: [client] });
    const loading = workbench.load();
    workbench.handleLogs({ logs: [log(11), log(12)], clients: [client] });
    finish(response(page([log(10)], 10)));
    await loading;
    expect(workbench.state.logs.map((item) => item.id)).toEqual([10, 11, 12]);
    expect(workbench.state.total).toBe(3);
  });

  it("服务端窗口翻尽后继续用本地历史分页，latest 回到实时", async () => {
    history = createLocalHistory()!;
    history.setServerId("server-a");
    history.append(Array.from({ length: 10 }, (_, i) => log(i + 1)));
    await history.page({ limit: 1, accept: () => true });

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(page([log(11), log(12)], 12)))
      .mockResolvedValue(response(page([log(11), log(12)], 12)));
    workbench = createWorkbench({ fetchImpl, history });
    workbench.handleHello({ serverId: "server-a", clients: [client] });
    await workbench.load();
    expect(workbench.state.logs.map((item) => item.id)).toEqual([11, 12]);

    await workbench.loadOlder();
    expect(workbench.state.localMode).toBe(true);
    expect(workbench.state.logs.map((item) => item.id)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);

    await workbench.latest();
    expect(workbench.state.localMode).toBe(false);
    expect(workbench.state.logs.map((item) => item.id)).toEqual([11, 12]);
  });

  it("重连后重新读取同一个历史页，并合入断线期间的事件", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        response(page([log(11), log(12)], 12, { hasMore: true })),
      )
      .mockResolvedValueOnce(response(page([log(5), log(6)], 6)))
      .mockResolvedValueOnce(response(page([log(5), log(6)], 6)));
    workbench = createWorkbench({ fetchImpl });
    workbench.handleHello({ serverId: "server-a", clients: [client] });
    await workbench.load();
    await workbench.loadOlder();
    expect(String(fetchImpl.mock.calls[1]![0])).toContain("before=11");

    workbench.handleLogs({ logs: [log(7)], clients: [client] });
    workbench.handleHello({ serverId: "server-a", clients: [client] });
    await vi.waitFor(() =>
      expect(String(fetchImpl.mock.calls[2]![0])).toContain("before=11"),
    );
  });

  it("点击后立即显示本地详情，不等待服务端往返，失败也不回到上一条", async () => {
    let finish!: (value: Response) => void;
    const fetchImpl = vi.fn().mockImplementation(
      () => new Promise<Response>((resolve) => { finish = resolve; }),
    );
    workbench = createWorkbench({ fetchImpl });
    workbench.state.logs = [log(1), log(2)];

    const first = workbench.openDetail(1);
    expect(workbench.state.detail?.log).toEqual(log(1));
    finish(response({ log: log(1), related: [] }));
    await first;

    const second = workbench.openDetail(2);
    expect(workbench.state.selectedId).toBe(2);
    expect(workbench.state.detail).toEqual({ log: log(2), related: [] });
    finish({ ok: false, status: 503 } as Response);
    await second;
    expect(workbench.state.detail?.log.id).toBe(2);
    expect(workbench.state.notice).toContain("HTTP 503");
  });

  it("接口详情立即展示本地关联记录，再补全服务端关联记录", async () => {
    let finish!: (value: Response) => void;
    workbench = createWorkbench({
      fetchImpl: vi.fn().mockImplementation(
        () => new Promise<Response>((resolve) => { finish = resolve; }),
      ),
    });
    const selected = httpLog(1, "request", "request-1");
    const related = httpLog(2, "response", "request-1");
    workbench.state.logs = [
      selected,
      related,
      { ...related, id: 3, clientKey: "client-b" },
      { ...related, id: 4, sessionId: "session-b" },
      httpLog(5, "response", "request-2"),
      { ...log(6), requestId: "request-1" },
    ];
    const opening = workbench.openDetail(1);
    expect(workbench.state.detail).toEqual({ log: selected, related: [related] });
    const earlier = httpLog(7, "request", "request-1");
    finish(response({ log: selected, related: [related, earlier] }));
    await opening;
    expect(workbench.state.detail).toEqual({ log: selected, related: [related, earlier] });
  });

  it("切换详情时迟到响应不会覆盖当前选择", async () => {
    const deferred: ((value: Response) => void)[] = [];
    const fetchImpl = vi.fn().mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          deferred.push(resolve);
        }),
    );
    workbench = createWorkbench({ fetchImpl });
    workbench.state.logs = [log(1), log(2)];
    workbench.state.serverId = "server-a";

    const first = workbench.openDetail(1);
    const second = workbench.openDetail(2);
    deferred[0]!(
      response({
        log: { ...log(1), eventId: "old" },
        related: [httpLog(3, "response", "request-1")],
      }),
    );
    await first;
    expect(workbench.state.selectedId).toBe(2);
    expect(workbench.state.detail).toEqual({ log: log(2), related: [] });

    deferred[1]!(response({ log: log(2), related: [] }));
    await second;
    expect(workbench.state.detail?.log.id).toBe(2);
  });

  it("后台详情拒绝重启后复用 id 的记录，关闭后也不被迟到响应重开", async () => {
    let finish!: (value: Response) => void;
    workbench = createWorkbench({
      fetchImpl: vi.fn().mockImplementation(
        () => new Promise<Response>((resolve) => { finish = resolve; }),
      ),
    });
    workbench.state.logs = [log(1)];
    const opening = workbench.openDetail(1);
    finish(response({ log: { ...log(1), eventId: "reused-id" }, related: [log(3)] }));
    await opening;
    expect(workbench.state.detail).toEqual({ log: log(1), related: [] });
    expect(workbench.state.notice).toContain("服务已重启");

    const reopening = workbench.openDetail(1);
    workbench.closeDetail();
    finish(response({ log: log(1), related: [log(3)] }));
    await reopening;
    expect(workbench.state.selectedId).toBeUndefined();
    expect(workbench.state.detail).toBeUndefined();
  });
});
