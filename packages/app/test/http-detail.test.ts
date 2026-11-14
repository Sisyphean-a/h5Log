// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
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
  expect(wrapper.find(".http-overview").text()).toContain("POST");
  expect(wrapper.find(".http-facts").text()).toContain("响应");
  expect(wrapper.find(".http-facts").text()).toContain("200");
  expect(wrapper.find(".http-facts").text()).toContain("0 ms");
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

it("失败信息、状态 0、空字符串、null 和非对象头信息都能读到", () => {
  const wrapper = mount(HttpDetail, { props: { payload: {
    phase: "error", method: "POST", url: "/api/orders", status: 0,
    headers: null, body: "", error: { name: "NetworkError", message: "网络中断" },
  } } });
  expect(wrapper.find(".http-facts").text()).toContain("失败");
  expect(wrapper.find(".http-facts").text()).toContain("HTTP 0");
  expect(wrapper.find('[data-http-section="headers"]').text()).toContain("null");
  expect(wrapper.find('[data-http-section="body"]').text()).toContain('""');
  expect(wrapper.find('[data-http-section="error"]').text()).toContain("网络中断");
  wrapper.unmount();
});

it("空记录和非对象头信息不会生成虚构字段或丢失内容", () => {
  const empty = mount(HttpDetail, { props: { payload: {} } });
  expect(empty.find(".http-overview").exists()).toBe(false);
  expect(empty.findAll(".http-section")).toHaveLength(0);
  expect(empty.find(".json").text()).toBe("{}");
  empty.unmount();
  const wrapper = mount(HttpDetail, { props: { payload: { headers: [["set-cookie", "one"], ["set-cookie", "two"]] } } });
  expect(JSON.parse(wrapper.find('[data-http-section="headers"] .json').text()))
    .toEqual([["set-cookie", "one"], ["set-cookie", "two"]]);
  wrapper.unmount();
});

function log(source: StoredLog["source"], args: JsonValue[]): StoredLog {
  return {
    id: 1, eventId: "event-a", appId: "demo", environment: "test",
    clientKey: "client-a", deviceId: "device-a", deviceName: "测试设备",
    sessionId: "session-a", userAgent: "test", pageUrl: "https://test.example",
    timestamp: 1, receivedAt: 1, level: "info", source, args,
  };
}

it("详情面板只拆分接口对象，保留附加输出与原始复制数据", async () => {
  const item = log("http", [{ phase: "request", requestId: "request-a", method: "POST", url: "/api/orders", body: { id: 1 } }, "附加输出"]);
  const related = [log("http", [{ phase: "response", status: 200 }])];
  const writeText = vi.fn().mockResolvedValue(undefined);
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const wrapper = mount(LogDetailPanel, { props: { detail: { log: item, related } } });
  try {
    expect(wrapper.findComponent(HttpDetail).exists()).toBe(true);
    expect(wrapper.findAll(".meta dt").map((item) => item.text())).toEqual(["应用", "设备", "页面"]);
    expect(wrapper.find('[data-http-section="args"]').text()).toContain("附加输出");
    await wrapper.find(".detail-actions button").trigger("click");
    expect(JSON.parse(writeText.mock.calls[0]![0])).toEqual({ log: item, related });
    await wrapper.setProps({ detail: { log: log("console", ["普通输出"]), related: [] } });
    expect(wrapper.findComponent(HttpDetail).exists()).toBe(false);
    expect(wrapper.find(".json").text()).toBe("普通输出");
  } finally {
    wrapper.unmount();
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});
