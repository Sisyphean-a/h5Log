import { expect, it } from "vitest";
import { jsonTokens, type JsonToken } from "../src/web/format.js";

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

it("超过上限时退化为单个纯文本块", () => {
  const text = JSON.stringify({ rows: Array.from({ length: 5000 }, (_, i) => i) }, null, 2);
  const tokens = jsonTokens(text);
  expect(tokens).toHaveLength(1);
  expect(tokens[0]!.kind).toBe("plain");
  expect(tokens[0]!.text).toBe(text);
});
