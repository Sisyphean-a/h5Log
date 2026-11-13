import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LogClient, LogPage, LogSession, StoredLog } from "@h5-log/sdk";
import { createWorkbench } from "../src/web/workbench.js";
import { createLocalHistory, type LocalHistory } from "../src/web/history.js";

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
