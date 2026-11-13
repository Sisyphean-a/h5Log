// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { LogPage, Logger, LoggerOptions } from "../src/types.js";
import { createLogger } from "../src/index.js";
import { createLogServer } from "../../app/src/server/index.js";

const instances: Logger[] = [];
afterEach(() => {
  for (const logger of instances.splice(0)) logger.stop();
});

it("SDK 允许的上下文边界可被真实服务端接受，保留原始测试内容", async () => {
  const app = createLogServer();
  await new Promise<void>((resolve) =>
    app.server.listen(0, "127.0.0.1", resolve),
  );
  const endpoint = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/logs`;
  const logger = createLogger({
    enabled: true,
    appId: "a".repeat(128),
    environment: "e".repeat(64),
    deviceName: "n".repeat(128),
    endpoint,
    captureConsole: false,
  });
  instances.push(logger);
  try {
    expect(logger.getStatus().enabled).toBe(true);
    logger.record("custom", "info", {
      token: "fake-token",
      payload: "a".repeat(1000),
    });
    await logger.flush();
    const result = (await (await fetch(endpoint)).json()) as LogPage;
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0]!.environment).toHaveLength(64);
    expect(result.logs[0]!.args[0]).toEqual({
      token: "fake-token",
      payload: "a".repeat(1000),
    });
    expect(logger.getStatus()).toMatchObject({ queued: 0, lastError: null });
  } finally {
    logger.stop();
    app.closeStreams();
    app.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      app.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it.each([
  ["appId", ""],
  ["appId", "a".repeat(129)],
  ["environment", ""],
  ["environment", "a".repeat(65)],
  ["deviceName", "a".repeat(129)],
] as const)("无效 %s 在初始化时禁用并说明原因", (field, value) => {
  const options: LoggerOptions = {
    enabled: true,
    appId: "26",
    endpoint: "https://logs.test/api/logs",
    captureConsole: false,
    [field]: value,
  };
  const logger = createLogger(options);
  instances.push(logger);
  expect(logger.getStatus()).toMatchObject({ enabled: false, queued: 0 });
  expect(logger.getStatus().lastError).toContain(field);
});
