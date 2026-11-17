import { expect, it } from "vitest";
import type { JsonValue, StoredLog } from "@h5-log/sdk";
import { defaultLogCopy, logCopyActions } from "../src/web/log-copy.js";

function log(source: StoredLog["source"], ...args: JsonValue[]): StoredLog {
  return {
    id: 1, appId: "demo", environment: "test", deviceId: "a", sessionId: "a",
    deviceName: "", userAgent: "", pageUrl: "https://h5.test/page/home", eventId: "a",
    timestamp: 1, receivedAt: 1, clientKey: "a", level: "info", source, args,
  };
}

it("普通复制保留完整正文、对象和附加输出，而不是列表摘要或元信息", () => {
  const text = "长日志".repeat(500);
  const entry = log("console", text, { a: 1 }, false, null);
  expect(logCopyActions(entry).map((item) => item.label)).toEqual(["复制"]);
  expect(defaultLogCopy(entry)).toEqual({ label: "日志内容", text: `${text} {\n  "a": 1\n} false null` });
  expect(logCopyActions(entry)[0]!.text).toBe(defaultLogCopy(entry).text);
});

it.each([
  ["home_page_view_repeat_h5", "home_page_view_repeat"],
  ["h5_home_page_view_repeat", "home_page_view_repeat"],
  ["home_h5_page_h5", "home_h5_page"],
])("埋点 %s 只去除边界标记，快捷复制优先原始埋点", (event, original) => {
  const entry = log("console", `[埋点] 复贷可申请首页展示 | ${event}`, { user: 1 });
  expect(logCopyActions(entry).map(({ label, text }) => [label, text])).toEqual([
    ["复制", `[埋点] 复贷可申请首页展示 | ${event} {\n  "user": 1\n}`],
    ["复制埋点", event],
    ["复制原始埋点", original],
  ]);
  expect(defaultLogCopy(entry)).toEqual({ text: original, label: "原始埋点" });
});

it.each(["home_page", "home_h5_page", "h5_home_h5", "h5_", "_h5"])("%s 不猜测原始埋点", (event) => {
  const entry = log("console", `[埋点] 展示 | ${event}`);
  expect(logCopyActions(entry).map((item) => item.label)).toEqual(["复制", "复制埋点"]);
  expect(defaultLogCopy(entry).text).toBe(entry.args[0]);
});

it.each(["[埋点] 展示", "展示 | home_h5", "[其他] 展示 | home_h5", "[埋点] 展示 | ", "[埋点] 展示 | home_h5 | more"])("不误识别普通文本 %s", (text) => {
  expect(logCopyActions(log("console", text)).map((item) => item.label)).toEqual(["复制"]);
});

it("只有控制台来源参与埋点识别", () => {
  const entry = log("custom", "[埋点] 展示 | home_h5");
  expect(logCopyActions(entry)).toHaveLength(1);
  expect(defaultLogCopy(entry).text).toBe(entry.args[0]);
});

it("请求提供头、体和可运行的 cURL，保留查询参数并转义单引号", () => {
  const entry = log("http", {
    phase: "request", method: "POST", url: "/api/items?tag=a&tag=b",
    headers: { "Content-Type": "application/json", "X-Token": "it's secret", "X-Multi": ["a", "b"], "X-Skip": false },
    body: { name: "O'Reilly" },
  });
  const actions = logCopyActions(entry);
  expect(actions.map((item) => item.label)).toEqual(["复制请求头", "复制请求体", "复制 cURL"]);
  expect(actions[0]!.text).toBe(JSON.stringify((entry.args[0] as Record<string, JsonValue>).headers, null, 2));
  expect(actions[1]!.text).toBe('{\n  "name": "O\'Reilly"\n}');
  expect(actions[2]!.text).toBe(`curl -X 'POST' 'https://h5.test/api/items?tag=a&tag=b' -H 'Content-Type: application/json' -H 'X-Token: it'"'"'s secret' -H 'X-Multi: a' -H 'X-Multi: b' --data-raw '{\n  "name": "O'"'"'Reilly"\n}'`);
  expect(defaultLogCopy(entry).text).toContain('"phase": "request"');
});

it.each(["response", "error"])("%s 仅提供响应头和响应体，不借用关联请求的数据", (phase) => {
  const actions = logCopyActions(log("http", { phase, headers: {}, body: { ok: true } }));
  expect(actions.map((item) => item.label)).toEqual(["复制响应头", "复制响应体"]);
  expect(actions.every((item) => !item.disabled)).toBe(true);
});

it.each([false, 0, null, ""])("响应正文 %j 不是缺失字段", (body) => {
  const actions = logCopyActions(log("http", { phase: "response", body }));
  expect(actions[0]!.disabled).toBe(true);
  expect(actions[1]!.disabled).toBe(false);
  expect(actions[1]!.text).toBe(typeof body === "string" ? body : JSON.stringify(body));
});

it("缺失字段和无效 URL 显式禁用，不复制 undefined 或伪造 cURL", () => {
  const actions = logCopyActions(log("http", { phase: "request", method: "GET", url: "javascript:alert(1)" }));
  expect(actions.every((item) => item.disabled && item.text === undefined)).toBe(true);
});

it("无正文 GET 不添加数据参数，已采集字符串正文保持原样", () => {
  expect(logCopyActions(log("http", { phase: "request", method: "GET", url: "./items", body: null }))[2]!.text)
    .toBe("curl -X 'GET' 'https://h5.test/page/items'");
  const actions = logCopyActions(log("http", { phase: "request", method: "POST", url: "/api", body: "a=1&b=2" }));
  expect(actions[1]!.text).toBe("a=1&b=2");
  expect(actions[2]!.text).toContain("--data-raw 'a=1&b=2'");
});
