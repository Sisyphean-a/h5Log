// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import type { LogClient, LogPage, StoredLog } from "@h5-log/sdk";
import App from "../src/web/App.vue";

const client: LogClient = {
  key: "client-a",
  appId: "26",
  environment: "test",
  deviceId: "phone-a",
  sessionId: "session-a",
  deviceName: "测试手机",
  userAgent: "WebView",
  lastSeen: Date.now(),
  logCount: 2,
  errorCount: 0,
};

function log(id: number, text: string): StoredLog {
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
    level: "info",
    source: "console",
    args: [text],
    receivedAt: 1700000000000 + id,
    clientKey: "client-a",
    eventId: `evt-${id}`,
  };
}

class Stream extends EventTarget {
  static instances: Stream[] = [];
  constructor() {
    super();
    Stream.instances.push(this);
  }
  close = vi.fn();
  emit(name: string, data: unknown) {
    this.dispatchEvent(new MessageEvent(name, { data: JSON.stringify(data) }));
  }
}

function pageBody(logs: StoredLog[]): LogPage {
  return {
    logs,
    clients: [client],
    sessions: [
      {
        clientKey: client.key,
        sessionId: client.sessionId,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        logCount: logs.length,
        errorCount: 0,
        pageUrl: "https://h5.test/home",
      },
    ],
    cursor: logs.at(-1)?.id ?? 0,
    hasMore: false,
    total: logs.length,
    retentionHours: 12,
    serverId: "server-a",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

it("默认盯住最近上报的客户端，输入关键词后新日志只显示匹配内容", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/logs?")) return { ok: true, json: async () => pageBody([log(1, "启动完成"), log(2, "订单详情已渲染")]) };
    return { ok: true, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", Stream);

  const wrapper = mount(App, { attachTo: document.body });
  const stream = Stream.instances.at(-1)!;
  stream.emit("hello", { serverId: "server-a", clients: [client] });

  await vi.waitFor(() =>
    expect(wrapper.findAll(".log-row")).toHaveLength(2),
  );
  // 单设备聚焦：客户端选择器展示选中的设备，而不是“全部客户端”
  expect(wrapper.find(".client-select").text()).toContain("测试手机");
  await vi.waitFor(() =>
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("clientKey=client-a"))).toBe(true),
  );

  const input = wrapper.find('input[placeholder*="搜索"]');
  await input.setValue("订单");
  await vi.waitFor(() => expect(wrapper.findAll(".log-row")).toHaveLength(1));

  stream.emit("logs", { logs: [log(3, "订单已提交"), log(4, "无关日志")], clients: [client] });
  await vi.waitFor(() => expect(wrapper.findAll(".log-row")).toHaveLength(2));
  expect(wrapper.text()).toContain("订单已提交");
  expect(wrapper.text()).not.toContain("无关日志");

  wrapper.unmount();
});

it("页面进入后退缓存时暂存工作台，返回后读取新日志并忽略旧连接事件", async () => {
  let logs = [log(1, "暂存前的日志")];
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    json: async () => pageBody(logs),
  })));
  vi.stubGlobal("EventSource", Stream);
  const wrapper = mount(App, { attachTo: document.body });
  try {
    await flushPromises();
    await vi.waitFor(() => expect(wrapper.text()).toContain("暂存前的日志"));
    const previous = Stream.instances.at(-1)!;
    window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
    expect(previous.close).toHaveBeenCalledOnce();

    logs = [log(2, "恢复后的新日志")];
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    await vi.waitFor(() => expect(wrapper.text()).toContain("恢复后的新日志"));
    expect(Stream.instances.at(-1)).not.toBe(previous);
    previous.emit("logs", {
      logs: [log(99, "旧连接的迟到日志")],
      clients: [client],
    });
    await flushPromises();
    expect(wrapper.text()).not.toContain("暂存前的日志");
    expect(wrapper.text()).not.toContain("旧连接的迟到日志");
    expect(wrapper.findAll(".log-row")).toHaveLength(1);
  } finally {
    wrapper.unmount();
  }
});
