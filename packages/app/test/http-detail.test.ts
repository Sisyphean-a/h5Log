// @vitest-environment jsdom
import { expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import type { JsonValue, StoredLog } from "@h5-log/sdk";
import HttpDetail from "../src/web/components/HttpDetail.vue";
import LogDetailPanel from "../src/web/components/LogDetailPanel.vue";

it("响应拆分为概览、查询参数、响应头和正文，并保留扩展字段", () => {
  const payload = {
    phase: "response", requestId: "request-a", method: "POST",
    url: "/api/orders?tag=one&tag=two&name=%E8%AE%A2%E5%8D%95#detail",
    status: 200, durationMs: 0,
    headers: { "content-type": "application/json", "x-preview": "<img src=x>" },
    body: '{"code":1000,"data":{"ok":true}}',
    trace: { region: "test" }, cached: false,
  };
  const raw = JSON.stringify(payload);
  const wrapper = mount(HttpDetail, { props: { payload } });
  expect(wrapper.get(".http-request-line").text()).toBe("POST" + payload.url);
  expect(wrapper.findAll('[data-http-section="query"] dd').map((item) => item.text()))
    .toEqual(["one", "two", "订单"]);
  expect(wrapper.find('[data-http-section="headers"] h3').text()).toBe("响应头");
  expect(wrapper.findAll('[data-http-section="headers"] dt')).toHaveLength(2);
  expect(JSON.parse(wrapper.find('[data-http-section="body"] .json').text()))
    .toEqual({ code: 1000, data: { ok: true } });
  expect(wrapper.findAll('[data-http-section="extra"] dt').map((item) => item.text()))
    .toEqual(["trace", "cached"]);
  const extraValues = wrapper.findAll('[data-http-section="extra"] dd');
  expect(JSON.parse(extraValues[0]!.text())).toEqual({ region: "test" });
  expect(extraValues[1]!.text()).toBe("false");
  expect(wrapper.find("img").exists()).toBe(false);
  expect(JSON.stringify(payload)).toBe(raw);
  wrapper.unmount();
});

it("接口请求标识不展示，也不误删业务正文中的同名字段", () => {
  const payload = { phase: "response", requestId: "outer-request-id", body: { requestId: "business-request-id" } };
  const raw = JSON.stringify(payload);
  const wrapper = mount(HttpDetail, { props: { payload } });
  expect(wrapper.find('[data-http-section="extra"]').exists()).toBe(false);
  expect(wrapper.text()).not.toContain("outer-request-id");
  expect(wrapper.find('[data-http-section="body"] .json').text()).toContain("business-request-id");
  expect(JSON.stringify(payload)).toBe(raw);
  wrapper.unmount();
});

it("请求仅展示存在的区域，正文 false 和显式参数不会被当成缺失", () => {
  const wrapper = mount(HttpDetail, { props: { payload: {
    phase: "request", method: "GET", url: "/api/orders#anchor?not=a-query",
    params: { page: 0 }, body: false,
  } } });
  expect(wrapper.find('[data-http-section="query"]').exists()).toBe(false);
  expect(wrapper.find('[data-http-section="headers"]').exists()).toBe(false);
  expect(wrapper.find('[data-http-section="error"]').exists()).toBe(false);
  expect(wrapper.find(".http-request-id").exists()).toBe(false);
  expect(wrapper.find('[data-http-section="params"] h3').text()).toBe("请求参数");
  expect(wrapper.find('[data-http-section="body"] h3').text()).toBe("请求正文");
  expect(wrapper.find('[data-http-section="body"] .json').text()).toBe("false");
  wrapper.unmount();
});

it("失败标记在详情标题，隐藏空正文但保留错误与显式头信息", () => {
  const wrapper = mount(LogDetailPanel, { props: { parsePageUrl: false, detail: { log: log("http", [{
    phase: "error", method: "POST", url: "/api/orders", status: 0,
    headers: null, body: "", error: { name: "NetworkError", message: "网络中断" },
  }]), related: [] } } });
  expect(wrapper.get(".detail-title").text()).toContain("失败");
  expect(wrapper.text()).not.toContain("HTTP 0");
  expect(wrapper.find('[data-http-section="headers"]').text()).toContain("null");
  expect(wrapper.find('[data-http-section="body"]').exists()).toBe(false);
  expect(wrapper.find('[data-http-section="error"]').text()).toContain("网络中断");
  wrapper.unmount();
});

it("空记录和非对象头信息不会生成虚构字段或丢失内容", () => {
  const empty = mount(HttpDetail, { props: { payload: {} } });
  expect(empty.find(".http-request-line").exists()).toBe(false);
  expect(empty.findAll(".http-section")).toHaveLength(0);
  expect(empty.find(".json").text()).toBe("{}");
  empty.unmount();
  const wrapper = mount(HttpDetail, { props: { payload: { headers: [["set-cookie", "one"], ["set-cookie", "two"]] } } });
  expect(JSON.parse(wrapper.find('[data-http-section="headers"] .json').text()))
    .toEqual([["set-cookie", "one"], ["set-cookie", "two"]]);
  wrapper.unmount();
});

it.each([null, "", "  ", "[undefined]", {}, [], "{}", "[ ]"])("空正文不渲染区域：%j", (body) => {
  for (const phase of ["request", "response"]) {
    const wrapper = mount(HttpDetail, { props: { payload: { phase, method: "GET", url: "/ping", params: {}, body } } });
    expect(wrapper.findAll(".http-section")).toHaveLength(0);
    wrapper.unmount();
  }
});

it.each(["request", "response"])("详情可复制 %s 的整段头/正文和单个值", async (phase) => {
  const headers = { "x-test": "a:b", "x-empty": "" };
  const body = { versionCode: 0, nested: ['a"b:c', false, null] };
  const request = phase === "request";
  const headerLabel = request ? "请求头" : "响应头";
  const bodyLabel = request ? "请求正文" : "响应正文";
  const wrapper = mount(LogDetailPanel, { props: { parsePageUrl: false, detail: {
    log: log("http", [{ phase, headers, body }]), related: [],
  } } });
  try {
    for (const label of [headerLabel, bodyLabel]) {
      await wrapper.get(`button[aria-label="复制${label}"]`).trigger("click");
    }
    for (const value of wrapper.findAll(".detail-copy-value")) {
      await value.trigger("click");
    }
    const copies = wrapper.emitted("copy")!;
    expect(copies.slice(0, 2).map(([text, label]) => [JSON.parse(text as string), label]))
      .toEqual([[headers, headerLabel], [body, bodyLabel]]);
    expect(copies.slice(2).map(([text]) => text))
      .toEqual(["a:b", "", "versionCode", "0", "nested", 'a"b:c', "false", "null"]);
  } finally {
    wrapper.unmount();
  }
});

it("大 JSON 的字符数不会让少量字段失去单值复制，普通文本不启用单值复制", async () => {
  const body = { text: "x".repeat(21000) };
  const wrapper = mount(HttpDetail, { props: { payload: { phase: "response", body } } });
  try {
    await wrapper.get(".tok-string.detail-copy-value").trigger("click");
    expect(wrapper.emitted("copy")?.[0]).toEqual([body.text, "响应正文值"]);
    await wrapper.setProps({ payload: { phase: "response", body: "普通文本：42" } });
    expect(wrapper.find(".detail-copy-value").exists()).toBe(false);
  } finally {
    wrapper.unmount();
  }
});

function log(source: StoredLog["source"], args: JsonValue[]): StoredLog {
  return {
    id: 1, eventId: "event-a", appId: "demo", environment: "test",
    clientKey: "client-a", deviceId: "device-a", deviceName: "测试设备",
    sessionId: "session-a", userAgent: "test", pageUrl: "https://test.example",
    timestamp: 1, receivedAt: 1, level: "info", source, args,
  };
}

it("解析页面 URL 时保留同名参数、空值和片段，文本不会作为 HTML 执行", async () => {
  const item = log("console", ["普通输出"]);
  item.pageUrl = "https://test.example/orders?tag=one&tag=%E8%AE%A2%E5%8D%95&empty=&q=<b>#section?anchor=1";
  const wrapper = mount(LogDetailPanel, { props: { parsePageUrl: true, detail: { log: item, related: [] } } });
  try {
    const page = wrapper.findAll(".meta > dd").at(-1)!;
    expect(page.get("code").text()).toBe("https://test.example/orders#section?anchor=1");
    expect(page.findAll("dl dt").map((key) => key.text())).toEqual(["tag", "tag", "empty", "q"]);
    expect(page.findAll("dl dd").map((value) => value.text())).toEqual(["one", "订单", '""', "<b>"]);
    expect(page.find("b").exists()).toBe(false);
    await wrapper.setProps({ parsePageUrl: false });
    expect(page.text()).toBe(item.pageUrl);
  } finally {
    wrapper.unmount();
  }
});

it.each(["", "https://test.example/orders?&&", "https://test.example/orders#anchor?not=a-query"])("无查询参数时没有切换按钮：%s", (pageUrl) => {
  const item = { ...log("console", ["普通输出"]), deviceName: "", pageUrl };
  const wrapper = mount(LogDetailPanel, { props: { parsePageUrl: true, detail: { log: item, related: [] } } });
  expect(wrapper.find(".meta button").exists()).toBe(false);
  expect(wrapper.findAll(".meta > dd")[1]!.text()).toBe("demo / test · device-a");
  expect(wrapper.findAll(".meta > dd").at(-1)!.text()).toBe(pageUrl || "—");
  wrapper.unmount();
});

it("详情面板只拆分接口对象，保留附加输出与原始复制数据", async () => {
  const item = log("http", [{ phase: "request", requestId: "request-a", method: "POST", url: "/api/orders", body: { id: 1 } }, "附加输出"]);
  const related = [log("http", [{ phase: "response", status: 200 }])];
  const wrapper = mount(LogDetailPanel, { props: { parsePageUrl: false, detail: { log: item, related } } });
  try {
    expect(wrapper.findComponent(HttpDetail).exists()).toBe(true);
    expect(wrapper.get(".detail-title").text()).toContain("请求");
    expect(wrapper.get(".http-request-line").text()).toBe("POST/api/orders");
    expect(wrapper.findAll(".meta > dt").map((item) => item.text())).toEqual(["接收时间", "应用设备", "页面"]);
    expect(wrapper.findAll(".meta dd")[1]!.text()).toBe("demo / test · 测试设备");
    expect(wrapper.find('[data-http-section="args"]').text()).toContain("附加输出");
    await wrapper.find(".detail-actions button").trigger("click");
    expect(JSON.parse(wrapper.emitted("copy")![0]![0] as string)).toEqual({ log: item, related });
    const response = log("http", [{ phase: "response", status: 200, durationMs: 822 }]);
    await wrapper.setProps({ detail: { log: response, related: [item] } });
    expect(wrapper.get(".detail-title").text()).toContain("响应");
    expect(wrapper.text()).not.toMatch(/HTTP 200|822 ms/);
    await wrapper.setProps({ detail: { log: log("console", ["普通输出"]), related: [] } });
    expect(wrapper.get(".detail-title").text()).not.toMatch(/请求|响应/);
    expect(wrapper.findComponent(HttpDetail).exists()).toBe(false);
    expect(wrapper.find(".json").text()).toBe("普通输出");
  } finally {
    wrapper.unmount();
  }
});
