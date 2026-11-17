import { expect, it } from "vitest";
import { compileSearchQuery } from "../src/search-query.js";

it.each([
  ["", "任意日志", true],
  ["   ", "任意日志", true],
  [" BRIDGE ", "jsBridge ready", true],
  ["a b", "a and b", false],
  ["a b", "a b ready", true],
  ["vite-hmr", "vite-hmr connected", true],
  ["a -b", "a ready", false],
  ["a && b", "a ready b", true],
  ["a && b", "a ready", false],
  ["a || b", "b ready", true],
  ["a || b", "idle", false],
  ["-c", "ready", true],
  ["-c", "connected", false],
  ["a && -c", "a ready", true],
  ["a && -c", "a connected", false],
  ["a && b || c", "c only", true],
  ["a && b || c", "a only", false],
  ["a || b && c", "a only", true],
  ["a || b && c", "b only", false],
  ["--a", "a ready", true],
  ["---a", "a ready", false],
  ["- c", "connected", false],
  ["订单 && -失败 || 超时", "订单已提交", true],
  ["订单 && -失败 || 超时", "订单失败", false],
  ["订单 && -失败 || 超时", "接口超时", true],
])("搜索 %j 匹配 %j：%s", (query, text, expected) => {
  expect(compileSearchQuery(query).matches(text)).toBe(expected);
});

it.each([
  ["a &&", "a", true],
  ["|| b", "b", true],
  ["a && - || b", "a", true],
  ["&& || -", "ready", false],
  ["&& || -", "prefix && || - suffix", true],
  ["-", "plain", false],
  ["-", "vite-hmr", true],
])("沿用 logcat 对输入中未完成表达式的处理：%j", (query, text, expected) => {
  expect(compileSearchQuery(query).matches(text)).toBe(expected);
});

it("仅提取去重后的正向高亮词，普通文本仍作为整体", () => {
  expect(compileSearchQuery(" Bridge && -token || READY || bridge ").highlightTerms).toEqual(["bridge", "ready"]);
  expect(compileSearchQuery("-token").highlightTerms).toEqual([]);
  expect(compileSearchQuery("a b").highlightTerms).toEqual(["a b"]);
  expect(compileSearchQuery(" ").highlightTerms).toEqual([]);
});
