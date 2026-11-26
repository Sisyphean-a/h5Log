// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { NDropdown, NSelect } from "naive-ui";
import type { LogClient, LogPage, StoredLog } from "@h5-log/sdk";
import App from "../src/web/App.vue";
import { ACCESS_KEY, clearAccessKey, readAccessKey, saveAccessKey } from "../src/web/access.js";
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

beforeEach(async () => {
  await saveAccessKey(ACCESS_KEY);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  localStorage.clear();
});

it.each(["stream", "snapshot"])("%s 发现服务实例变化时刷新整页，首次连接和同实例重连不刷新", async (detection) => {
  const reload = vi.fn();
  vi.stubGlobal("location", { pathname: "/", reload });
  let currentPage = pageBody([log(1, "旧实例记录")]);
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => currentPage }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", Stream);
  const wrapper = mount(App, { attachTo: document.body });
  try {
    await vi.waitFor(() => expect(wrapper.findAll(".log-row")).toHaveLength(1));
    const stream = Stream.instances.at(-1)!;
    stream.emit("hello", { serverId: "server-a", clients: [client] });
    await flushPromises();
    expect(reload).not.toHaveBeenCalled();

    stream.emit("error", {});
    stream.emit("hello", { serverId: "server-a", clients: [client] });
    await flushPromises();
    expect(reload).not.toHaveBeenCalled();

    currentPage = { ...pageBody([]), serverId: "server-b", clients: [], sessions: [] };
    const reads = fetchMock.mock.calls.length;
    if (detection === "stream") {
      stream.emit("hello", { serverId: "server-b", clients: [] });
      expect(reload).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(reads);
    } else {
      await wrapper.find('button[aria-label="最新"]').trigger("click");
      await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    }
    expect(stream.close).toHaveBeenCalled();
    stream.emit("hello", { serverId: "server-c", clients: [] });
    await flushPromises();
    expect(reload).toHaveBeenCalledTimes(1);
  } finally {
    wrapper.unmount();
  }
});

it("设备目录清空时不把内部 JSON 标识当作设备名称", async () => {
  const key = JSON.stringify(["26", "test", "phone-a"]);
  const device = { ...client, key };
  let currentPage = { ...pageBody([]), clients: [device], sessions: [] };
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => currentPage })));
  vi.stubGlobal("EventSource", Stream);
  const wrapper = mount(App, { attachTo: document.body });
  try {
    const select = wrapper.findComponent(NSelect);
    await vi.waitFor(() => expect(select.text()).toContain("测试手机"));
    currentPage = { ...pageBody([]), clients: [], sessions: [] };
    Stream.instances.at(-1)!.emit("clients", { clients: [], expiresBefore: 0, evictedThroughId: 0 });
    await flushPromises();
    expect(select.text()).not.toContain(key);
    expect(select.text()).toContain("选择设备");
  } finally {
    wrapper.unmount();
  }
});

it.each([
  ["/h5-log/console/%E5%9F%8B%E7%82%B9", "console", "埋点"],
  ["/h5-log/interface", "http", ""],
  ["/h5-log/error/超时", "error", "超时"],
])("路径 %s 初始化筛选", async (path, source, search) => {
  window.history.replaceState({}, "", path);
  const fetchMock = vi.fn(async (_input: RequestInfo | URL) => ({ ok: true, json: async () => pageBody([]) }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", Stream);
  const wrapper = mount(App, { attachTo: document.body });
  try {
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => {
      const value = String(url);
      return value.startsWith("./api/logs?") && new URLSearchParams(value.split("?")[1]).get("source") === source &&
        (new URLSearchParams(value.split("?")[1]).get("search") ?? "") === search;
    })).toBe(true));
    expect((wrapper.find('input[placeholder="搜索日志内容"]').element as HTMLInputElement).value).toBe(search);
  } finally {
    wrapper.unmount();
    window.history.replaceState({}, "", "/");
  }
});

it("顶部集中筛选与阅读操作，辅助入口只保留可访问的服务状态图标", async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => ({
    ok: true,
    json: async () => String(input) === "./api/status" ? {
      uptimeSeconds: 480, logs: 1, bytes: 200, clients: 1, subscribers: 1, received: 1, evicted: 0,
      limits: { maxLogs: 8000, maxBytes: 16 * 2 ** 20, maxSubscribers: 50, maxEventBytes: 128 * 1024 },
      resources: {
        sampledAt: Date.now(),
        hostCpu: { current: 12.5, peak: 25 },
        hostMemory: { current: 2 ** 30, peak: 2 * 2 ** 30, total: 8 * 2 ** 30 },
        processCpu: { current: 2.5, peak: 4 },
        processMemory: { current: 90 * 2 ** 20, peak: 100 * 2 ** 20 },
      },
    } : pageBody([log(1, "当前记录")]),
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
    await vi.waitFor(() => expect(document.body.textContent).toContain("资源监控"));
    expect(fetchMock.mock.calls.some(([url]) => url === "./api/status")).toBe(true);
    expect(document.body.textContent).toContain("宿主机总内存 8.00 GiB");
    expect(document.body.textContent).toContain("100.0 MiB");
    const statusLabels = [...document.querySelectorAll(".status-list dt")].map((label) => label.textContent);
    expect(statusLabels).toEqual(["运行时长", "当前条数", "当前体积", "设备", "查看连接", "累计接收 / 淘汰"]);
    expect(document.body.textContent).not.toMatch(/电脑与服务的连接|最近收到服务推送|服务器 ID|保留时长|电脑连接正常不代表|采样时间|每约 10 秒采样/);
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

it("页面 URL 默认显示原文，全局切换在日志之间共享，并恢复两种已保存的状态", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  await saveAccessKey(ACCESS_KEY);
  const entries = [1, 2].map((id) => ({ ...log(id, `日志 ${id}`), pageUrl: `https://h5.test/home?id=${id}` }));
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => ({
    ok: true,
    json: async () => {
      const entry = entries.find(({ id }) => String(input) === `./api/logs/${id}`);
      return entry ? { log: entry, related: [] } : pageBody(entries);
    },
  })));
  vi.stubGlobal("EventSource", Stream);
  const prefs = localHistory.createLocalHistory()!;
  let wrapper = mount(App, { attachTo: document.body });
  const toggle = () => wrapper.get(".page-url-toggle");
  async function openLog(index: number) {
    await vi.waitFor(() => expect(wrapper.findAll(".log-row")).toHaveLength(2));
    await wrapper.findAll(".log-row")[index]!.trigger("click");
  }
  function reload() {
    wrapper.unmount();
    wrapper = mount(App, { attachTo: document.body });
  }
  try {
    await openLog(0);
    expect(toggle().attributes("aria-pressed")).toBe("false");
    expect(wrapper.get(".meta > dd:last-child").text()).toBe(entries[0]!.pageUrl);
    await toggle().trigger("click");
    await vi.waitFor(async () => expect(await prefs.loadPageUrlParsing()).toBe(true));
    await openLog(1);
    expect(wrapper.get(".page-url-params dd").text()).toBe("2");

    reload();
    await openLog(0);
    await vi.waitFor(() => expect(toggle().attributes("aria-pressed")).toBe("true"));
    await toggle().trigger("click");
    await vi.waitFor(async () => expect(await prefs.loadPageUrlParsing()).toBe(false));
    await openLog(1);
    expect(wrapper.get(".meta > dd:last-child").text()).toBe(entries[1]!.pageUrl);

    reload();
    await openLog(1);
    expect(toggle().attributes("aria-pressed")).toBe("false");
  } finally {
    wrapper.unmount();
    prefs.dispose();
  }
});

it("详情宽度从 IndexedDB 恢复，拖动结束保存，重开页面沿用偏好而非窄窗口的限制值", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  await saveAccessKey(ACCESS_KEY);
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
  await saveAccessKey(ACCESS_KEY);
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

it("输入和替换关键词立即预览当前页并高亮，不等待防抖或网络", async () => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => pageBody([
    log(1, "启动完成"), log(2, "submitTrack 订单已提交"),
  ]) }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", Stream);
  const wrapper = mount(App, { attachTo: document.body });
  try {
    await vi.waitFor(() => expect(wrapper.findAll(".log-row")).toHaveLength(2));
    await flushPromises();
    vi.useFakeTimers();
    const requests = fetchMock.mock.calls.length;
    const input = wrapper.find('input[placeholder*="搜索"]');
    await input.setValue("submitTrack");
    expect(wrapper.findAll(".log-row")).toHaveLength(1);
    expect(wrapper.find(".search-hit").text()).toBe("submitTrack");
    expect(fetchMock).toHaveBeenCalledTimes(requests);
    await input.setValue("启动");
    expect(wrapper.findAll(".log-row")).toHaveLength(1);
    expect(wrapper.find(".log-row").text()).toContain("启动完成");
    await input.setValue("");
    expect(wrapper.findAll(".log-row")).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(requests);
  } finally {
    wrapper.unmount();
    vi.useRealTimers();
  }
});

it("布尔搜索立即预览并高亮，提交后继续过滤实时日志", async () => {
  const entries = [log(1, "启动完成"), log(2, "Bridge token ready"), log(3, "Bridge token debug"), log(4, "fallback")];
  const query = "bridge && token && -debug || fallback";
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const search = new URL(String(input), "http://localhost").searchParams.get("search");
    return { ok: true, json: async () => pageBody(search ? [entries[1]!, entries[3]!] : entries) };
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", Stream);
  const wrapper = mount(App, { attachTo: document.body });
  try {
    await vi.waitFor(() => expect(wrapper.findAll(".log-row")).toHaveLength(4));
    await flushPromises();
    vi.useFakeTimers();
    const requests = fetchMock.mock.calls.length;
    await wrapper.find('input[placeholder*="搜索"]').setValue(query);
    expect(wrapper.findAll(".log-row")).toHaveLength(2);
    expect(wrapper.findAll(".search-hit").map((hit) => hit.text())).toEqual(["Bridge", "token", "fallback"]);
    expect(fetchMock).toHaveBeenCalledTimes(requests);
    await vi.advanceTimersByTimeAsync(250);
    await flushPromises();
    expect(new URL(String(fetchMock.mock.calls.at(-1)![0]), "http://localhost").searchParams.get("search")).toBe(query);
    Stream.instances.at(-1)!.emit("logs", {
      logs: [log(5, "Bridge token ready"), log(6, "Bridge token debug"), log(7, "无关日志"), log(8, "fallback")], clients: [client],
    });
    await flushPromises();
    expect(wrapper.findAll(".log-row")).toHaveLength(4);
    expect(wrapper.findAll(".log-row").map((row) => row.attributes("data-log-id"))).toEqual(["2", "4", "5", "8"]);
  } finally {
    wrapper.unmount();
    vi.useRealTimers();
  }
});

it("搜索慢网时保留命中行，快速替换关键词忽略旧响应，失败也不清空结果", async () => {
  const entries = [log(1, "submitTrack 订单已提交"), log(2, "启动完成")];
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const search = new URL(String(input), "http://localhost").searchParams.get("search");
    if (search) return new Promise((resolve, reject) => pending.set(search, { resolve, reject }));
    return Promise.resolve({ ok: true, json: async () => pageBody(entries) });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", Stream);
  const wrapper = mount(App, { attachTo: document.body });
  try {
    await vi.waitFor(() => expect(wrapper.findAll(".log-row")).toHaveLength(2));
    await flushPromises();
    vi.useFakeTimers();
    const input = wrapper.find('input[placeholder*="搜索"]');
    await input.setValue("submitTrack");
    await vi.advanceTimersByTimeAsync(250);
    expect(pending.has("submitTrack")).toBe(true);
    expect(wrapper.findAll(".log-row")).toHaveLength(1);
    expect(wrapper.find(".log-row").text()).toContain("submitTrack");
    await input.setValue("启动");
    await vi.advanceTimersByTimeAsync(250);
    pending.get("submitTrack")!.resolve({ ok: true, json: async () => pageBody([log(3, "旧响应")]) });
    await flushPromises();
    expect(wrapper.find(".log-row").text()).toContain("启动完成");
    pending.get("启动")!.reject(new Error("网络不可用"));
    await flushPromises();
    expect(wrapper.find(".log-row").text()).toContain("启动完成");
    expect(wrapper.text()).toContain("网络不可用");
  } finally {
    wrapper.unmount();
    vi.useRealTimers();
  }
});

it("达到 2000 行上限后仍跟随最新日志，暂停时保留原行与滚动位置", async () => {
  const entries = Array.from({ length: 2000 }, (_, index) => log(index + 1, `记录-${index + 1}`));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => pageBody(entries) })));
  vi.stubGlobal("EventSource", Stream);
  const wrapper = mount(App, { attachTo: document.body });
  try {
    await vi.waitFor(() => expect(wrapper.findAll(".log-row")).toHaveLength(2000));
    await flushPromises();
    const workspace = wrapper.find<HTMLElement>(".workspace").element;
    let height = 1000;
    Object.defineProperty(workspace, "scrollHeight", { configurable: true, get: () => height });
    workspace.scrollTop = height;
    height = 1100;
    Stream.instances.at(-1)!.emit("logs", { logs: [log(2001, "最新记录")], clients: [client] });
    await flushPromises();
    expect(wrapper.findAll(".log-row")).toHaveLength(2000);
    expect(workspace.scrollTop).toBe(height);
    await wrapper.find(".toggle").trigger("click");
    const first = wrapper.get(".log-row").element;
    height = 1200;
    Stream.instances.at(-1)!.emit("logs", { logs: [log(2002, "暂停期间记录")], clients: [client] });
    await flushPromises();
    expect(wrapper.get(".log-row").element).toBe(first);
    expect(wrapper.find('[data-log-id="2002"]').exists()).toBe(false);
    expect(workspace.scrollTop).toBe(1100);
    await wrapper.find(".toggle").trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-log-id="2002"]').exists()).toBe(true);
    expect(workspace.scrollTop).toBe(height);
  } finally {
    wrapper.unmount();
  }
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

async function mountCopyScenario(logs: StoredLog[], pendingDetail = false) {
  const writeText = vi.fn(async (_text: string) => undefined);
  vi.stubGlobal("navigator", new Proxy(navigator, {
    get: (target, key) => key === "clipboard" ? { writeText } : Reflect.get(target, key, target),
  }));
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const id = /^\.\/api\/logs\/(\d+)$/.exec(url)?.[1];
    if (id && pendingDetail) return new Promise<never>(() => {});
    return { ok: true, json: async () => id
      ? { log: logs.find((item) => item.id === Number(id)), related: [] }
      : pageBody(logs) };
  }));
  vi.stubGlobal("EventSource", Stream);
  const wrapper = mount(App, { attachTo: document.body });
  await vi.waitFor(() => expect(wrapper.findAll(".log-row")).toHaveLength(logs.length));
  return { wrapper, writeText };
}

it("右键阻止原生菜单，先选中并展示详情；后台请求未完成也能显示埋点菜单和复制", async () => {
  const { wrapper, writeText } = await mountCopyScenario([
    log(1, "之前的条目"), log(2, "[埋点] 复贷可申请首页展示 | home_page_view_repeat_h5"),
  ], true);
  try {
    await wrapper.find('[data-log-id="1"]').trigger("click");
    const row = wrapper.find('[data-log-id="2"]');
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 120, clientY: 180 });
    row.element.dispatchEvent(event);
    await flushPromises();
    expect(event.defaultPrevented).toBe(true);
    expect(row.classes()).toContain("selected");
    expect(wrapper.find("#log-detail").text()).toContain("home_page_view_repeat_h5");
    const menu = wrapper.findComponent(NDropdown);
    expect(menu.props("show")).toBe(true);
    expect([menu.props("x"), menu.props("y")]).toEqual([120, 180]);
    await vi.waitFor(() => expect(document.body.textContent).toContain("复制原始埋点"));
    const option = [...document.querySelectorAll(".n-dropdown-option-body")].find((item) => item.textContent?.includes("复制原始埋点"));
    expect(option).toBeTruthy();
    (option as HTMLElement).click();
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith("home_page_view_repeat");
    expect(wrapper.find(".toast").text()).toBe("已复制原始埋点：home_page_view_repeat");
    expect(menu.props("show")).toBe(false);
  } finally {
    wrapper.unmount();
  }
});

it.each(["request", "response"])("右键 %s 只显示对应接口菜单并复制当前条目的正文", async (phase) => {
  const entry: StoredLog = {
    ...log(2, ""), source: "http",
    args: [{ phase, method: "POST", url: "/api/items", headers: { token: "test" }, body: { phase } }],
  };
  const { wrapper, writeText } = await mountCopyScenario([log(1, "旧条目"), entry], true);
  try {
    await wrapper.find('[data-log-id="1"]').trigger("click");
    await wrapper.find('[data-log-id="2"]').trigger("contextmenu");
    const menu = wrapper.findComponent(NDropdown);
    const label = phase === "request" ? "请求" : "响应";
    expect((menu.props("options") as { label: string }[]).map((item) => item.label))
      .toEqual([`复制${label}头`, `复制${label}体`, ...(phase === "request" ? ["复制 cURL"] : [])]);
    const option = [...document.querySelectorAll(".n-dropdown-option-body")].find((item) => item.textContent?.includes(`复制${label}体`));
    (option as HTMLElement).click();
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith(JSON.stringify({ phase }, null, 2));
    expect(wrapper.find(".toast").text()).toBe(`已复制${label}体：{ "phase": "${phase}" }`);
  } finally {
    wrapper.unmount();
  }
});

it("详情标题和单个 JSON 键通过同一剪贴板通路复制，并显示正确的类型", async () => {
  const entry: StoredLog = {
    ...log(1, ""), source: "http",
    args: [{ phase: "response", headers: { "content-type": "application/json" }, body: { ok: true } }],
  };
  const { wrapper, writeText } = await mountCopyScenario([entry]);
  try {
    await wrapper.get(".log-row").trigger("click");
    await wrapper.get('button[aria-label="复制响应正文"]').trigger("click");
    await flushPromises();
    expect(writeText).toHaveBeenLastCalledWith(JSON.stringify({ ok: true }, null, 2));
    expect(wrapper.get(".toast").text()).toBe('已复制响应正文：{ "ok": true }');
    await wrapper.get("button.tok-key").trigger("click");
    await flushPromises();
    expect(writeText).toHaveBeenLastCalledWith("ok");
    expect(wrapper.get(".toast").text()).toBe("已复制响应正文键：ok");
  } finally {
    wrapper.unmount();
  }
});

it("快捷复制完整条目或原始埋点；输入框和未选中时不拦截，复制失败明确反馈", async () => {
  const text = "完整日志".repeat(500);
  const { wrapper, writeText } = await mountCopyScenario([log(1, text), log(2, "[埋点] 展示 | h5_home_view")]);
  const copy = (target: EventTarget, metaKey = false) => {
    const event = new KeyboardEvent("keydown", { key: "c", ctrlKey: !metaKey, metaKey, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };
  try {
    expect(copy(document).defaultPrevented).toBe(false);
    await wrapper.find('[data-log-id="1"]').trigger("click");
    expect(copy(document).defaultPrevented).toBe(false);
    expect(copy(wrapper.find('[data-log-id="1"]').element).defaultPrevented).toBe(true);
    await flushPromises();
    expect(writeText).toHaveBeenLastCalledWith(text);
    const toast = wrapper.find(".toast").text();
    expect(toast).toContain("已复制日志内容：完整日志");
    expect(toast.endsWith("…")).toBe(true);
    expect(toast.length).toBeLessThan(120);
    await wrapper.find('[data-log-id="2"]').trigger("click");
    copy(wrapper.find('[data-log-id="2"]').element, true);
    await flushPromises();
    expect(writeText).toHaveBeenLastCalledWith("home_view");
    expect(wrapper.find(".toast").text()).toBe("已复制原始埋点：home_view");
    const count = writeText.mock.calls.length;
    expect(copy(wrapper.find("input").element).defaultPrevented).toBe(false);
    expect(writeText).toHaveBeenCalledTimes(count);
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    document.body.append(editable);
    expect(copy(editable).defaultPrevented).toBe(false);
    expect(writeText).toHaveBeenCalledTimes(count);
    writeText.mockRejectedValueOnce(new Error("权限被拒绝"));
    copy(wrapper.find('[data-log-id="2"]').element);
    await flushPromises();
    expect(wrapper.find(".toast").text()).toContain("复制失败：权限被拒绝");
  } finally {
    wrapper.unmount();
  }
});

it("详情选文优先原生复制，即使焦点留在列表；列表外也不触发埋点快捷复制", async () => {
  const { wrapper, writeText } = await mountCopyScenario([log(1, "[埋点] 首页子产品点击 | h5_home_sub_product_click")]);
  const selection = window.getSelection()!;
  const copy = (target: EventTarget) => {
    const event = new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };
  try {
    const row = wrapper.find('[data-log-id="1"]');
    await row.trigger("click");
    row.element.focus();
    const content = wrapper.find("#log-detail .block").element;
    const range = document.createRange();
    range.selectNodeContents(content);
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selection.toString()).toContain("首页子产品点击");
    expect(copy(row.element).defaultPrevented).toBe(false);
    expect(copy(content).defaultPrevented).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    selection.removeAllRanges();
    for (const target of [content, wrapper.find(".workbench-header button").element, document.body]) {
      expect(copy(target).defaultPrevented).toBe(false);
    }
    expect(writeText).not.toHaveBeenCalled();
    const crossPaneRange = document.createRange();
    crossPaneRange.setStart(row.element, 0);
    crossPaneRange.setEnd(content, content.childNodes.length);
    selection.addRange(crossPaneRange);
    expect(copy(row.element).defaultPrevented).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    selection.removeAllRanges();
    expect(copy(row.element).defaultPrevented).toBe(true);
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith("home_sub_product_click");
  } finally {
    selection.removeAllRanges();
    wrapper.unmount();
  }
});

it("详情 JSON 复制显示内容预览，失败时不伪报成功", async () => {
  const { wrapper, writeText } = await mountCopyScenario([log(1, "日志正文")]);
  try {
    await wrapper.find('[data-log-id="1"]').trigger("click");
    const button = wrapper.find("#log-detail .detail-actions button");
    await button.trigger("click");
    await flushPromises();
    expect(writeText.mock.calls[0]![0]).toContain("日志正文");
    expect(wrapper.find(".toast").text()).toContain('已复制详情 JSON：{ "log":');
    writeText.mockRejectedValueOnce(new Error("剪贴板不可用"));
    await button.trigger("click");
    await flushPromises();
    expect(wrapper.find(".toast").text()).toBe("复制失败：剪贴板不可用");
  } finally {
    wrapper.unmount();
  }
});

it("菜单在 Escape、滚动、外部点击和切换条目时关闭，Escape 不关闭当前详情", async () => {
  const { wrapper } = await mountCopyScenario([log(1, "第一条"), log(2, "第二条")]);
  const menu = wrapper.findComponent(NDropdown);
  const open = () => wrapper.find('[data-log-id="1"]').trigger("contextmenu");
  try {
    await open();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await flushPromises();
    expect(menu.props("show")).toBe(false);
    expect(wrapper.find("#log-detail").exists()).toBe(true);
    await open();
    document.dispatchEvent(new Event("scroll"));
    await flushPromises();
    expect(menu.props("show")).toBe(false);
    await open();
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    document.body.click();
    await flushPromises();
    expect(menu.props("show")).toBe(false);
    await open();
    await wrapper.find('[data-log-id="2"]').trigger("click");
    expect(menu.props("show")).toBe(false);
  } finally {
    wrapper.unmount();
  }
});

it("检查已保存的登录状态时只显示加载提示，不闪现密钥表单", async () => {
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => pageBody([]) }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", Stream);
  const wrapper = mount(App, { attachTo: document.body });
  try {
    expect(wrapper.text()).toContain("正在检查登录状态");
    expect(wrapper.find("#access-key").exists()).toBe(false);
    expect(wrapper.text()).not.toContain("输入访问密钥");
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(wrapper.find(".access-gate").exists()).toBe(false));
    expect(fetchMock).toHaveBeenCalled();
  } finally {
    wrapper.unmount();
  }
});

it("未解锁时蒙版挡住日志，输入正确密钥后写入 IndexedDB 并直接解锁", async () => {
  await clearAccessKey();
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => pageBody([log(1, "验证后的日志")]),
  }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", Stream);
  const wrapper = mount(App, { attachTo: document.body });
  try {
    await vi.waitFor(() => expect(wrapper.find(".access-gate").exists()).toBe(true));
    await vi.waitFor(() => expect(wrapper.find("#access-key").attributes("disabled")).toBeUndefined());
    expect(wrapper.text()).toContain("输入访问密钥");
    const streamsBefore = Stream.instances.length;
    expect(fetchMock).not.toHaveBeenCalled();
    expect(Stream.instances).toHaveLength(streamsBefore);

    const input = wrapper.find("#access-key");
    await input.setValue("0000");
    await vi.waitFor(() => expect(wrapper.text()).toContain("密钥不正确"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(Stream.instances).toHaveLength(streamsBefore);

    await input.setValue(ACCESS_KEY);
    await vi.waitFor(() => expect(wrapper.find(".access-gate").exists()).toBe(false));
    await vi.waitFor(() => expect(wrapper.findAll(".log-row")).toHaveLength(1));
    expect(await readAccessKey()).toBe(ACCESS_KEY);
    expect(fetchMock).toHaveBeenCalled();
  } finally {
    wrapper.unmount();
  }
});
