// @vitest-environment jsdom
import { expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import JsonBlock from "../src/web/components/JsonBlock.vue";
import { jsonDisplayText, jsonText, jsonTokens, type JsonToken } from "../src/web/format.js";

function kinds(tokens: JsonToken[]): [string, string][] {
  return tokens
    .filter((token) => token.kind !== "plain")
    .map((token) => [token.kind, token.text]);
}

it("区分键、字符串、数字、字面量与标点", () => {
  const text = `{
  "name": "订单 \\"加急\\"",
  "count": -2.5e3,
  "done": false,
  "extra": null
}`;
  expect(kinds(jsonTokens(text))).toEqual([
    ["punct", "{"],
    ["key", '"name"'],
    ["punct", ":"],
    ["string", '"订单 \\"加急\\""'],
    ["punct", ","],
    ["key", '"count"'],
    ["punct", ":"],
    ["number", "-2.5e3"],
    ["punct", ","],
    ["key", '"done"'],
    ["punct", ":"],
    ["literal", "false"],
    ["punct", ","],
    ["key", '"extra"'],
    ["punct", ":"],
    ["literal", "null"],
    ["punct", "}"],
  ]);
  expect(jsonTokens(text).map((token) => token.text).join("")).toBe(text);
});

it("数组、根字符串与转义反斜杠保持原文", () => {
  const text = '["a\\b", 1, true]';
  const tokens = jsonTokens(text);
  expect(tokens.map((token) => token.text).join("")).toBe(text);
  expect(kinds(tokens)).toEqual([
    ["punct", "["],
    ["string", '"a\\b"'],
    ["punct", ","],
    ["number", "1"],
    ["punct", ","],
    ["literal", "true"],
    ["punct", "]"],
  ]);
});

it("详情展开带前缀的 JSON 字符串，普通文字与无效 JSON 保持原样", () => {
  const value = '[h5-JSBridge] {"msgTag":"AirUpload","data":{"message":"hello"}}';
  expect(jsonDisplayText(value)).toBe('[h5-JSBridge]\n{\n  "msgTag": "AirUpload",\n  "data": {\n    "message": "hello"\n  }\n}');
  expect(jsonDisplayText('结果 [1,{"ok":true}]')).toBe('结果\n[\n  1,\n  {\n    "ok": true\n  }\n]');
  for (const text of ['普通文本', '  保留空格\n与换行  ', '[tag] {invalid}', 'count: 123', 'true']) {
    expect(jsonDisplayText(text)).toBe(text);
  }
});

it("详情展开对象和数组内部的 JSON 字符串，但复制仍保留原始类型与转义", () => {
  const value = {
    body: '{"rows":[{"value":"{\\"ok\\":true}"}]}',
    args: ['{"text":"C:\\\\temp","html":"<script>no()</script>"}', '123'],
  };
  const raw = jsonText(value);
  expect(JSON.parse(jsonDisplayText(value))).toEqual({
    body: { rows: [{ value: { ok: true } }] },
    args: [{ text: "C:\\temp", html: "<script>no()</script>" }, "123"],
  });
  expect(jsonText(value)).toBe(raw);
  expect(JSON.parse(raw).body).toBe(value.body);
});

it("详情组件直接展示格式化文本，不把日志内的 HTML 当成页面执行", () => {
  const value = '[h5-JSBridge] {"payload":"{\\"ok\\":true}","message":"<img src=x onerror=alert(1)>"}';
  const wrapper = mount(JsonBlock, { props: { value } });
  expect(wrapper.find(".json").text()).toBe(jsonDisplayText(value));
  expect(wrapper.text()).toContain('"payload": {\n    "ok": true\n  }');
  expect(wrapper.find("img").exists()).toBe(false);
  wrapper.unmount();
});

it("超过上限时退化为单个纯文本块", () => {
  const text = JSON.stringify({ rows: Array.from({ length: 5000 }, (_, i) => i) }, null, 2);
  const tokens = jsonTokens(text);
  expect(tokens).toHaveLength(1);
  expect(tokens[0]!.kind).toBe("plain");
  expect(tokens[0]!.text).toBe(text);
});
