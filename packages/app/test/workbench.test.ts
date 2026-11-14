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
});

describe("工作台状态", () => {
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

  it("切换详情时迟到响应不会覆盖当前选择，重启后的同 id 记录被拒绝", async () => {
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
    expect(workbench.state.detail).toBeUndefined();

    deferred[1]!(response({ log: log(2), related: [] }));
    await second;
    expect(workbench.state.detail?.log.id).toBe(2);
  });
});
