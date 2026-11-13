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

  expect(wrapper.find('[data-log-id="2"]').classes()).toContain("related");
  expect(wrapper.find('[data-log-id="3"]').classes()).not.toContain("related");
  expect(wrapper.find('[data-log-id="1"] .log-text').text()).toBe(
    "→ GET /api/health",
  );

  await wrapper.setProps({ selectedId: 2 });
  await flushPromises();
  expect(wrapper.find('[data-log-id="1"]').classes()).toContain("related");
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
