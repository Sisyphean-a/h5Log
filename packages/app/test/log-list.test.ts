// @vitest-environment jsdom
import { expect, it } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import type { StoredLog } from "@h5-log/sdk";
import LogList from "../src/web/components/LogList.vue";

function httpLog(
  id: number,
  requestId: string,
  phase: "request" | "response",
): StoredLog {
  return {
    id,
    appId: "demo-h5",
    environment: "test",
    deviceId: "device-a",
    sessionId: "session-a",
    deviceName: "",
    userAgent: "WebView",
    pageUrl: "https://h5.test/home",
    eventId: `evt-${id}`,
    timestamp: 1700000000000 + id,
    receivedAt: 1700000000000 + id,
    level: "info",
    source: "http",
    args: [{ requestId, phase, method: "GET", url: "/api/health" }],
    clientKey: "device-a|demo-h5|test",
  };
}

it("选中网络日志时标记同一次请求的可见记录", async () => {
  const wrapper = mount(LogList, {
    props: {
      logs: [
        httpLog(1, "request-a", "request"),
        httpLog(2, "request-a", "response"),
        httpLog(3, "request-b", "request"),
      ],
      selectedId: 1,
    },
  });
  await flushPromises();

  expect(wrapper.findAll(".log-level, .level-dot")).toHaveLength(0);
  expect(wrapper.find(".log-source").attributes("title")).toBe("接口 · 信息");
  expect(wrapper.find('[data-log-id="2"]').classes()).toContain("related");
  expect(wrapper.find('[data-log-id="3"]').classes()).not.toContain("related");
  expect(wrapper.find('[data-log-id="1"] .log-text').text()).toBe(
    "→ GET /api/health",
  );

  await wrapper.setProps({ selectedId: 2 });
  await flushPromises();
  expect(wrapper.find('[data-log-id="1"]').classes()).toContain("related");
});

it("同一设备的新采集只提示一次，交错上报不重复提示且不跨采集关联请求", async () => {
  const logs = [
    httpLog(1, "request-a", "request"),
    { ...httpLog(2, "request-a", "request"), sessionId: "session-b" },
    httpLog(3, "request-a", "response"),
    { ...httpLog(4, "request-a", "response"), sessionId: "session-b" },
  ];
  const raw = JSON.stringify(logs);
  const wrapper = mount(LogList, { props: { logs, selectedId: 1 } });
  expect(wrapper.findAll(".reporting-label").map((item) => item.text()))
    .toEqual(["开始上报", "重新开始上报"]);
  expect(wrapper.findAll(".reporting-marker").map((item) => item.attributes("data-reporting-log-id")))
    .toEqual(["1", "2"]);
  expect(wrapper.findAll(".log-row.related").map((item) => item.attributes("data-log-id")))
    .toEqual(["3"]);
  expect(wrapper.findAll(".log-row")).toHaveLength(4);
  expect(wrapper.find(".reporting-marker").attributes("title")).toContain("首条可见");
  expect(wrapper.text()).not.toContain("断开");
  expect(JSON.stringify(logs)).toBe(raw);

  await wrapper.setProps({ logs: logs.slice(2) });
  expect(wrapper.findAll(".reporting-marker").map((item) => item.attributes("data-reporting-log-id")))
    .toEqual(["3", "4"]);
  wrapper.unmount();
});

it("多设备分别识别开始上报，空列表不制造状态提示", async () => {
  const wrapper = mount(LogList, { props: {
    logs: [
      { ...httpLog(1, "request-a", "request"), deviceName: "设备 A" },
      { ...httpLog(2, "request-b", "request"), clientKey: "client-b", deviceId: "device-b", deviceName: "设备 B" },
      { ...httpLog(3, "request-c", "request"), sessionId: "session-b", deviceName: "设备 A" },
    ],
    selectedId: undefined,
  } });
  expect(wrapper.findAll(".reporting-label").map((item) => item.text()))
    .toEqual(["开始上报", "开始上报", "重新开始上报"]);
  expect(wrapper.findAll(".reporting-device").map((item) => item.text()))
    .toEqual(["设备 A · demo-h5/test", "设备 B · demo-h5/test", "设备 A · demo-h5/test"]);
  await wrapper.setProps({ logs: [] });
  expect(wrapper.findAll(".reporting-marker, .log-row")).toHaveLength(0);
  wrapper.unmount();
});

it("选中普通日志时不显示关联线", () => {
  const wrapper = mount(LogList, {
    props: {
      logs: [
        {
          ...httpLog(4, "request-c", "request"),
          source: "console",
          args: ["普通日志"],
        },
      ],
      selectedId: 4,
    },
  });

  expect(wrapper.findAll(".log-row.related")).toHaveLength(0);
  expect(wrapper.find(".log-links").exists()).toBe(false);
});
