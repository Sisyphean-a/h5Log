import { expect, it } from "vitest";
import {
  highlightLogText,
  tokenizeLogText,
  type LogTokenKind,
} from "../src/web/highlight.js";

function kinds(text: string): Array<[LogTokenKind, string]> {
  return tokenizeLogText(text).map((token) => [token.kind, token.text]);
}

it("识别日志开头的方括号标签", () => {
  expect(kinds("[h5-page] {\"page\":\"baseInfo\"}")[0]).toEqual([
    "tag",
    "[h5-page]",
  ]);
  expect(kinds("  [h5-JSBridge] send")).toContainEqual([
    "tag",
    "[h5-JSBridge]",
  ]);
  expect(kinds("[埋点] 首贷可申请首页展示 | home_page_view_login_h5")[0]).toEqual([
    "tag",
    "[埋点]",
  ]);
  expect(kinds(" [h5-页面] 展示")).toContainEqual(["tag", "[h5-页面]"]);
  expect(kinds("普通 [h5-page] 不在开头")).not.toContainEqual([
    "tag",
    "[h5-page]",
  ]);
});

it("识别请求方法、路径、耗时与百分比", () => {
  expect(kinds("→ GET /api/app/h5/v4/index 200 · 995 ms")).toEqual([
    ["http-prefix", "→ GET /api/app/h5/v4/"],
    ["http-name", "index"],
    ["plain", " 200 · "],
    ["metric", "995 ms"],
  ]);
  expect(kinds("使用率 50%")).toContainEqual(["metric", "50%"]);
});

it.each([
  ["→ POST /api/app/inpage/checkCusBlackList", "checkCusBlackList"],
  ["← GET /api/app/getUser?redirect=/other/name#section", "getUser"],
  ["→ GET https://api.example/v1/users/?next=/another/path", "users"],
  ["→ DELETE /api/删除记录?ids=1,2", "删除记录"],
  ["→ HEAD /?next=/home", "/"],
])("接口只突出查询参数前的末段名称：%s", (text, name) => {
  const tokens = tokenizeLogText(text);
  expect(tokens.filter((token) => token.kind === "http-name").map((token) => token.text).join("")).toBe(name);
  expect(tokens.map((token) => token.text).join("")).toBe(text);
  const pieces = highlightLogText(text, name);
  expect(pieces.filter((piece) => piece.hit).map((piece) => piece.text).join("")).toContain(name);
  expect(pieces.some((piece) => piece.kind === "http-name" && piece.hit)).toBe(true);
});

it("识别 URL、错误关键词和堆栈", () => {
  expect(kinds("打开 https://h5.test/demo?from=log 失败")).toContainEqual([
    "url",
    "https://h5.test/demo?from=log",
  ]);
  expect(kinds("TypeError: 失败")).toContainEqual([
    "error-keyword",
    "TypeError",
  ]);
  expect(kinds("TypeError: 失败")).toContainEqual(["error-keyword", "失败"]);
  expect(kinds("at /src/app.vue:12:3")).toEqual([
    ["stack-prefix", "at"],
    ["plain", " "],
    ["stack-frame", "/src/app.vue:12:3"],
  ]);
});

it("搜索命中保留语义 token 并切分命中片段", () => {
  const text = "POST /api/orders 200";
  const pieces = highlightLogText(text, "orders");
  expect(pieces.map((piece) => piece.text).join("")).toBe(text);
  expect(pieces).toContainEqual({ text: "orders", kind: "path", hit: true });
  expect(
    pieces.filter((piece) => piece.hit).map((piece) => piece.text).join(""),
  ).toBe("orders");

  const crossing = highlightLogText("GET /api/orders", "GET /api");
  expect(crossing.map((piece) => piece.text).join("")).toBe("GET /api/orders");
  expect(
    crossing.filter((piece) => piece.hit).map((piece) => piece.text).join(""),
  ).toBe("GET /api");
});

it("布尔搜索只高亮正向关键词，不高亮运算符和排除词", () => {
  const text = "Bridge token ready && ||";
  const pieces = highlightLogText(text, "BRIDGE && -token || ready");
  expect(pieces.filter((piece) => piece.hit).map((piece) => piece.text)).toEqual(["Bridge", "ready"]);
  expect(pieces.map((piece) => piece.text).join("")).toBe(text);
  expect(highlightLogText(text, "-token").some((piece) => piece.hit)).toBe(false);
});

it("多词重叠或跨语义 token 时不重复正文、不丢失高亮", () => {
  const text = "GET /api/orders";
  const pieces = highlightLogText(text, "GET /api || /api/orders || orders");
  expect(pieces.map((piece) => piece.text).join("")).toBe(text);
  expect(pieces.filter((piece) => piece.hit).map((piece) => piece.text).join("")).toBe(text);
  expect(pieces.some((piece) => piece.kind === "http-method" && piece.hit)).toBe(true);
});

it("空关键词不产生命中片段", () => {
  const pieces = highlightLogText("TypeError: 失败", "");
  expect(pieces.some((piece) => piece.hit)).toBe(false);
  expect(pieces.map((piece) => piece.text).join("")).toBe("TypeError: 失败");
});
