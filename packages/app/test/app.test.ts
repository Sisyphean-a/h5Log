// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { NSelect } from "naive-ui";
import type { LogClient, LogPage, StoredLog } from "@h5-log/sdk";
import App from "../src/web/App.vue";
import * as localHistory from "../src/web/history.js";

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
  localStorage.clear();
});

it("顶部集中筛选与阅读操作，辅助入口只保留可访问的服务状态图标", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => ({
    ok: true,
    json: async () => String(input) === "./api/health" ? undefined : pageBody([log(1, "当前记录")]),
  }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", Stream);
  const wrapper = mount(App, { attachTo: document.body });
  try {
    await vi.waitFor(() => expect(wrapper.findAll(".log-row")).toHaveLength(1));
    const header = wrapper.find("header");
    expect(header.findAllComponents(NSelect)).toHaveLength(3);
    expect(header.find('input[placeholder="搜索日志内容"]').exists()).toBe(true);
    expect(header.findAll(".action-row button").map((button) => button.attributes("aria-label")))
      .toEqual(["更早", "最新", "清空视图"]);
    expect(header.find(".brand").exists()).toBe(false);
    expect(header.text()).not.toMatch(/\d+ 条|实时连接|连接中/);
    expect(header.find(".toggle").attributes("aria-pressed")).toBe("true");
    await header.find(".toggle").trigger("click");
    expect(header.find(".toggle").attributes("aria-pressed")).toBe("false");
    expect(wrapper.find("aside").exists()).toBe(false);
    const service = header.find('button[aria-label="服务状态"]');
    expect(service.find("svg").exists()).toBe(true);
    expect(service.text()).toBe("");
    expect(service.attributes("title")).toContain("连接中");
    Stream.instances.at(-1)!.dispatchEvent(new Event("open"));
    await flushPromises();
    expect(service.attributes("data-state")).toBe("connecting");
    Stream.instances.at(-1)!.emit("hello", { serverId: "server-a", clients: [client] });
    await flushPromises();
    expect(service.attributes("data-state")).toBe("open");
    expect(service.attributes("title")).toContain("实时连接");
    expect(wrapper.text()).not.toMatch(/接入 SDK|复制列表|导出列表/);
    await service.trigger("click");
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "./api/health")).toBe(true));
    expect(document.body.textContent).toContain("正在读取服务状态");
  } finally {
    wrapper.unmount();
  }
});

it("电脑重新联网或恢复前台时重建订阅，卸载后移除监听", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => pageBody([log(1, "当前记录")]) })));
  vi.stubGlobal("EventSource", Stream);
  const wrapper = mount(App, { attachTo: document.body });
  try {
    await vi.waitFor(() => expect(wrapper.findAll(".log-row")).toHaveLength(1));
    const current = Stream.instances.at(-1)!;
    window.dispatchEvent(new Event("online"));
    expect(current.close).toHaveBeenCalledOnce();
    const resumed = Stream.instances.at(-1)!;
    expect(resumed).not.toBe(current);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(resumed.close).toHaveBeenCalledOnce();
  } finally {
    wrapper.unmount();
  }
  const count = Stream.instances.length;
  window.dispatchEvent(new Event("online"));
  document.dispatchEvent(new Event("visibilitychange"));
  expect(Stream.instances).toHaveLength(count);
});

it("工具栏精简后仍明确显示加载与读取失败状态", async () => {
  let rejectRequest!: (error: Error) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise((_resolve, reject) => { rejectRequest = reject; })));
  vi.stubGlobal("EventSource", Stream);
  const wrapper = mount(App, { attachTo: document.body });
  try {
    await vi.waitFor(() => expect(wrapper.find(".empty-title").text()).toBe("正在读取日志…"));
    rejectRequest(new Error("日志服务暂不可达"));
    await vi.waitFor(() => expect(wrapper.find('[role="alert"]').text()).toContain("日志服务暂不可达"));
    expect(wrapper.find(".empty-title").text()).not.toContain("正在读取");
  } finally {
    wrapper.unmount();
  }
});

it("清空图标只清空视图，并保留恢复日志的入口", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => pageBody([log(1, "仍在服务器的日志")]) })));
  vi.stubGlobal("EventSource", Stream);
  const wrapper = mount(App, { attachTo: document.body });
  try {
    await vi.waitFor(() => expect(wrapper.findAll(".log-row")).toHaveLength(1));
    await wrapper.find('button[aria-label="清空视图"]').trigger("click");
    expect(wrapper.find(".empty-title").text()).toBe("视图已清空");
    expect(wrapper.find(".hint").text()).toContain("服务器日志仍在");
    await wrapper.find(".empty-action").trigger("click");
    await vi.waitFor(() => expect(wrapper.findAll(".log-row")).toHaveLength(1));
    expect(wrapper.find(".log-text").text()).toBe("仍在服务器的日志");
  } finally {
    wrapper.unmount();
  }
});

it("详情分隔条支持拖动、键盘和宽度边界，关闭重开保留当前宽度", async () => {
  const entry = log(1, "可调整宽度的详情");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => ({
    ok: true,
    json: async () => String(input) === "./api/logs/1" ? { log: entry, related: [] } : pageBody([entry]),
  })));
  vi.stubGlobal("EventSource", Stream);
  const wrapper = mount(App, { attachTo: document.body });
  try {
    let width = 1400;
    const body = wrapper.find(".body");
    vi.spyOn(body.element, "getBoundingClientRect").mockImplementation(() => ({ width }) as DOMRect);
    window.dispatchEvent(new Event("resize"));
    await vi.waitFor(() => expect(wrapper.findAll(".log-row")).toHaveLength(1));
    await wrapper.find(".log-row").trigger("click");
    await vi.waitFor(() => expect(wrapper.find('.detail-resizer').exists()).toBe(true));
    let handle = wrapper.find('[role="separator"][aria-label="调整详情面板宽度"]');
    const initial = Number(handle.attributes("aria-valuenow"));
    const capture = vi.fn();
    Object.assign(handle.element, { setPointerCapture: capture });
    async function pointer(type: string, clientX = 0): Promise<void> {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX });
      Object.defineProperty(event, "pointerId", { value: 1 });
      handle.element.dispatchEvent(event);
      await flushPromises();
    }
    await pointer("pointerdown", 900);
    expect(capture).toHaveBeenCalledWith(1);
    await pointer("pointermove", 800);
    expect(Number(handle.attributes("aria-valuenow"))).toBe(initial + 100);
    expect(body.attributes("style")).toContain(`--detail-width: ${initial + 100}px`);
    await pointer("pointermove", -10000);
    expect(handle.attributes("aria-valuenow")).toBe("1068");
    await pointer("pointermove", 10000);
    expect(handle.attributes("aria-valuenow")).toBe("320");
    await pointer("pointercancel");
    expect(body.classes()).not.toContain("is-resizing");
    await pointer("pointermove", 700);
    expect(handle.attributes("aria-valuenow")).toBe("320");

    await handle.trigger("keydown", { key: "ArrowLeft" });
    expect(handle.attributes("aria-valuenow")).toBe("336");
    await handle.trigger("keydown", { key: "ArrowLeft", shiftKey: true });
    expect(handle.attributes("aria-valuenow")).toBe("384");
    await handle.trigger("keydown", { key: "End" });
    expect(handle.attributes("aria-valuenow")).toBe("1068");
    width = 1000;
    window.dispatchEvent(new Event("resize"));
    await flushPromises();
    expect(handle.attributes("aria-valuenow")).toBe("668");
    await handle.trigger("keydown", { key: "Home" });
    await handle.trigger("keydown", { key: "ArrowRight" });
    expect(handle.attributes("aria-valuenow")).toBe("320");
    await handle.trigger("keydown", { key: "ArrowLeft" });
    await wrapper.findAll(".detail-actions button")[1]!.trigger("click");
    expect(wrapper.find('.detail-resizer').exists()).toBe(false);
    await wrapper.find(".log-row").trigger("click");
    await vi.waitFor(() => expect(wrapper.find('.detail-resizer').exists()).toBe(true));
    handle = wrapper.find('[role="separator"][aria-label="调整详情面板宽度"]');
    expect(handle.attributes("aria-valuenow")).toBe("336");
  } finally {
    wrapper.unmount();
  }
});

it("详情宽度从 IndexedDB 恢复，拖动结束保存，重开页面沿用偏好而非窄窗口的限制值", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const entry = log(1, "记住详情宽度");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => ({
    ok: true,
    json: async () => String(input) === "./api/logs/1" ? { log: entry, related: [] } : pageBody([entry]),
  })));
  vi.stubGlobal("EventSource", Stream);
  const prefs = localHistory.createLocalHistory()!;
  const wrappers: { unmount(): void }[] = [];
  let width = 1400;
  async function openPage(expected: number) {
    const wrapper = mount(App, { attachTo: document.body });
    wrappers.push(wrapper);
    vi.spyOn(wrapper.find(".body").element, "getBoundingClientRect").mockImplementation(() => ({ width }) as DOMRect);
    window.dispatchEvent(new Event("resize"));
    await vi.waitFor(() => expect(wrapper.findAll(".log-row")).toHaveLength(1));
    await wrapper.find(".log-row").trigger("click");
    await vi.waitFor(() => expect(wrapper.find(".detail-resizer").attributes("aria-valuenow")).toBe(String(expected)));
    return wrapper;
  }
  try {
    await prefs.saveDetailWidth(640);
    const first = await openPage(640);
    const handle = first.find(".detail-resizer");
    Object.assign(handle.element, { setPointerCapture: vi.fn() });
    async function pointer(type: string, clientX: number) {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX });
      Object.defineProperty(event, "pointerId", { value: 1 });
      handle.element.dispatchEvent(event);
      await flushPromises();
    }
    await pointer("pointerdown", 900);
    await pointer("pointermove", 800);
    expect(handle.attributes("aria-valuenow")).toBe("740");
    expect(await prefs.loadDetailWidth()).toBe(640);
    await pointer("pointerup", 800);
    await vi.waitFor(async () => expect(await prefs.loadDetailWidth()).toBe(740));
    await handle.trigger("keydown", { key: "ArrowLeft" });
    await vi.waitFor(async () => expect(await prefs.loadDetailWidth()).toBe(756));
    first.unmount();
    const second = await openPage(756);
    width = 900;
    window.dispatchEvent(new Event("resize"));
    await flushPromises();
    expect(second.find(".detail-resizer").attributes("aria-valuenow")).toBe("568");
    expect(await prefs.loadDetailWidth()).toBe(756);
    width = 1400;
    window.dispatchEvent(new Event("resize"));
    await flushPromises();
    expect(second.find(".detail-resizer").attributes("aria-valuenow")).toBe("756");
  } finally {
    for (const wrapper of wrappers) wrapper.unmount();
    prefs.dispose();
  }
});

it("迟到的宽度读取不覆盖手动调整，保存失败明确提示", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const local = localHistory.createLocalHistory()!;
  let resolveWidth!: (width: number) => void;
  vi.spyOn(local, "loadDetailWidth").mockReturnValue(new Promise((resolve) => { resolveWidth = resolve; }));
  vi.spyOn(local, "saveDetailWidth").mockRejectedValue(new Error("偏好写入失败"));
  vi.spyOn(localHistory, "createLocalHistory").mockReturnValue(local);
  const entry = log(1, "读取偏好期间操作");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => ({
    ok: true,
    json: async () => String(input) === "./api/logs/1" ? { log: entry, related: [] } : pageBody([entry]),
  })));
  vi.stubGlobal("EventSource", Stream);
  const wrapper = mount(App, { attachTo: document.body });
  try {
    vi.spyOn(wrapper.find(".body").element, "getBoundingClientRect").mockReturnValue({ width: 1400 } as DOMRect);
    window.dispatchEvent(new Event("resize"));
    await vi.waitFor(() => expect(wrapper.findAll(".log-row")).toHaveLength(1));
    await wrapper.find(".log-row").trigger("click");
    await vi.waitFor(() => expect(wrapper.find(".detail-resizer").exists()).toBe(true));
    const handle = wrapper.find(".detail-resizer");
    await handle.trigger("keydown", { key: "ArrowLeft" });
    const adjusted = handle.attributes("aria-valuenow");
    await vi.waitFor(() => expect(wrapper.find(".toast").text()).toContain("保存详情宽度失败：偏好写入失败"));
    resolveWidth(800);
    await flushPromises();
    expect(handle.attributes("aria-valuenow")).toBe(adjusted);
  } finally {
    wrapper.unmount();
  }
});

it("默认盯住最近上报的客户端，输入关键词后新日志只显示匹配内容", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("./api/logs?")) return { ok: true, json: async () => pageBody([log(1, "启动完成"), log(2, "订单详情已渲染")]) };
    return { ok: true, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", Stream);

  const wrapper = mount(App, { attachTo: document.body });
  let stream = Stream.instances.at(-1)!;
  stream.emit("hello", { serverId: "server-a", clients: [client] });

  await vi.waitFor(() =>
    expect(wrapper.findAll(".log-row")).toHaveLength(2),
  );
  expect(wrapper.find(".action-row button").attributes("disabled")).toBeDefined();
  // 单设备聚焦：客户端选择器展示选中的设备，而不是“全部客户端”
  expect(wrapper.find(".client-select").text()).toContain("测试手机");
  await vi.waitFor(() =>
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("clientKey=client-a"))).toBe(true),
  );

  stream = Stream.instances.at(-1)!;
  stream.emit("hello", { serverId: "server-a", clients: [client] });
  await flushPromises();
  const input = wrapper.find('input[placeholder*="搜索"]');
  await input.setValue("订单");
  await vi.waitFor(() => expect(wrapper.findAll(".log-row")).toHaveLength(1));

  stream.emit("logs", { logs: [log(3, "订单已提交"), log(4, "无关日志")], clients: [client] });
  await vi.waitFor(() => expect(wrapper.findAll(".log-row")).toHaveLength(2));
  expect(wrapper.text()).toContain("订单已提交");
  expect(wrapper.text()).not.toContain("无关日志");

  wrapper.unmount();
});

it("滚动到顶部不会偷偷翻页，更早只由按钮触发", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const before = new URL(String(input), "http://localhost").searchParams.has("before");
    return { ok: true, json: async () => ({
      ...pageBody(before ? [log(1, "更早记录")] : [log(2, "当前记录 A"), log(3, "当前记录 B")]),
      total: 3,
      hasMore: !before,
    }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", Stream);
  const wrapper = mount(App, { attachTo: document.body });
  try {
    await vi.waitFor(() => expect(wrapper.findAll(".log-row")).toHaveLength(2));
    await flushPromises();
    const calls = fetchMock.mock.calls.length;
    await wrapper.find(".workspace").trigger("scroll");
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    expect(wrapper.findAll(".log-row")).toHaveLength(2);
    await wrapper.find(".action-row button").trigger("click");
    await vi.waitFor(() => expect(wrapper.findAll(".log-row")).toHaveLength(1));
    expect(wrapper.find(".log-text").text()).toBe("更早记录");
    expect(wrapper.find(".action-row button").attributes("disabled")).toBeDefined();
  } finally {
    wrapper.unmount();
  }
});

it("空历史页不冒充整个范围无日志，并提供查看最新的入口", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ...pageBody([]), total: 3 }) })));
  vi.stubGlobal("EventSource", Stream);
  const wrapper = mount(App, { attachTo: document.body });
  try {
    await vi.waitFor(() => expect(wrapper.find(".empty-title").text()).toBe("当前页没有日志"));
    expect(wrapper.find(".empty-action").text()).toBe("查看最新日志");
  } finally {
    wrapper.unmount();
  }
});

it("来源支持多选且没有自定义入口，清空后恢复全部来源", async () => {
  const logs: StoredLog[] = [
    log(1, "控制台日志"),
    { ...log(2, "接口日志"), source: "http" },
    { ...log(3, "异常日志"), source: "error", level: "error" },
    { ...log(4, "既有自定义日志"), source: "custom" },
  ];
  const fetchMock = vi.fn(async (_input: RequestInfo | URL) => ({ ok: true, json: async () => pageBody(logs) }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", Stream);
  const wrapper = mount(App, { attachTo: document.body });
  try {
    await vi.waitFor(() => expect(wrapper.findAll(".log-row")).toHaveLength(4));
    const select = wrapper.findAllComponents(NSelect)
      .find((item) => item.props("placeholder") === "全部来源")!;
    expect(select.props("multiple")).toBe(true);
    expect(select.props("value")).toEqual([]);
    expect(select.props("options").map((option) => option.value)).toEqual(["console", "error", "http"]);

    select.vm.$emit("update:value", ["console", "http"]);
    await vi.waitFor(() => expect(wrapper.findAll(".log-row")).toHaveLength(2));
    await vi.waitFor(() => expect(fetchMock.mock.calls.some((call) =>
      new URL(String(call[0]), "http://localhost").searchParams.get("source") === "console,http",
    )).toBe(true));
    expect(wrapper.find(".list-head").text()).not.toContain("级别");

    select.vm.$emit("update:value", []);
    await vi.waitFor(() => expect(wrapper.findAll(".log-row")).toHaveLength(4));
    expect(select.props("value")).toEqual([]);
  } finally {
    wrapper.unmount();
  }
});

it("设备视图合并多次启动，不再提供会话筛选，提示不计入日志条数", async () => {
  const logs = [log(1, "第一次启动"), { ...log(2, "第二次启动"), sessionId: "session-b" }, log(3, "第一次启动继续上报")];
  const fetchMock = vi.fn(async (_input: RequestInfo | URL) => ({ ok: true, json: async () => pageBody(logs) }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", Stream);
  const wrapper = mount(App, { attachTo: document.body });
  try {
    await vi.waitFor(() => expect(wrapper.findAll(".log-row")).toHaveLength(3));
    expect(wrapper.findAllComponents(NSelect).map((item) => item.props("placeholder")))
      .toEqual(["选择设备", "级别", "全部来源"]);
    expect(wrapper.findAll(".reporting-label").map((item) => item.text()))
      .toEqual(["开始上报", "重新开始上报"]);
    expect(fetchMock.mock.calls.every((call) =>
      !new URL(String(call[0]), "http://localhost").searchParams.has("sessionId"),
    )).toBe(true);
  } finally {
    wrapper.unmount();
  }
});

it("隐藏其他设备只收缩当前浏览器的设备候选，不删除服务端范围", async () => {
  localStorage.clear();
  const other = {
    ...client,
    key: "client-b",
    deviceId: "phone-b",
    deviceName: "备用手机",
    lastSeen: Date.now() - 60_000,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ...pageBody([log(1, "来自主设备")]),
        clients: [client, other],
      }),
    })),
  );
  vi.stubGlobal("EventSource", Stream);
  const wrapper = mount(App, { attachTo: document.body });
  const stream = Stream.instances.at(-1)!;
  stream.emit("hello", { serverId: "server-a", clients: [client, other] });

  await vi.waitFor(() => expect(wrapper.findAll(".log-row")).toHaveLength(1));
  const select = wrapper
    .findAllComponents(NSelect)
    .find((item) => item.classes().includes("client-select"))!;
  expect(select.props("options")).toHaveLength(2);

  await wrapper.find(".scope-action").trigger("click");
  expect(select.props("options")).toHaveLength(1);
  expect(wrapper.find(".scope-action").attributes("aria-label")).toBe("显示全部设备");

  await wrapper.find(".scope-action").trigger("click");
  expect(select.props("options")).toHaveLength(2);
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
