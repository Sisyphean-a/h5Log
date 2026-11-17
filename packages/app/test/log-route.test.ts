import { expect, it } from "vitest";
import { parseLogRoute } from "../src/log-route.js";

it("从路径读取来源和可选的搜索条件", () => {
  expect(parseLogRoute("/h5-log/console/%E5%9F%8B%E7%82%B9")).toEqual({
    index: 7, source: "console", search: "埋点",
  });
  expect(parseLogRoute("/interface")).toEqual({ index: 0, source: "http", search: "" });
  expect(parseLogRoute("/error/a%2Fb/")).toEqual({ index: 0, source: "error", search: "a/b" });
  expect(parseLogRoute("/h5-log/")).toBeUndefined();
  expect(parseLogRoute("/console/a/b")).toBeUndefined();
  expect(parseLogRoute("/console/%E5")).toBeUndefined();
});
