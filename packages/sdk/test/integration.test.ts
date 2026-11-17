// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { CompressionStream as NativeCompressionStream } from "node:stream/web";
import type { AddressInfo } from "node:net";
import type { LogPage, Logger, LoggerOptions } from "../src/types.js";
import { createLogger } from "../src/index.js";
import { createLogServer } from "../../app/src/server/index.js";

const instances: Logger[] = [];
afterEach(() => {
  for (const logger of instances.splice(0)) logger.stop();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

it("稳定设备标识贯通真实上传与工作台目录，重新采集归并且同型号按设备编号", async () => {
  const app = createLogServer();
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/logs`;
  try {
    const sessions = [];
    for (const deviceId of ["gaid-phone-a", "gaid-phone-a", "gaid-phone-b", "gaid-phone-c"]) {
      const logger = createLogger({
        enabled: true, appId: "26", environment: "test", endpoint,
        deviceId, deviceName: "SM-A156U", captureConsole: false,
      });
      instances.push(logger);
      sessions.push(logger.context.sessionId);
      logger.record("custom", "info", "device-identity-probe");
      await logger.flush();
      expect(logger.getStatus()).toMatchObject({ sent: 1, lastError: null });
      logger.stop();
    }
    const result = (await (await fetch(endpoint)).json()) as LogPage;
    expect(result.logs).toHaveLength(4);
    expect(new Set(sessions).size).toBe(4);
    expect(result.clients).toHaveLength(3);
    expect(result.clients).toEqual(expect.arrayContaining([
      expect.objectContaining({ deviceId: "gaid-phone-a", deviceName: "SM-A156U-1", logCount: 2 }),
      expect.objectContaining({ deviceId: "gaid-phone-b", deviceName: "SM-A156U-2", logCount: 1 }),
      expect.objectContaining({ deviceId: "gaid-phone-c", deviceName: "SM-A156U-3", logCount: 1 }),
    ]));
  } finally {
    await app.close();
  }
});

it("SDK 原生压缩通过真实 HTTP 服务解压，查询返回相同正文且重试不重复", async () => {
  vi.stubGlobal("CompressionStream", NativeCompressionStream);
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const app = createLogServer();
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/logs`;
  const logger = createLogger({ enabled: true, appId: "26", endpoint, captureConsole: false });
  instances.push(logger);
  try {
    const payload = { token: "fake-token", body: "完整请求正文".repeat(3000) };
    logger.record("custom", "info", payload);
    await logger.flush();
    const [, request] = fetchSpy.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect((request!.headers as Record<string, string>)["Content-Encoding"]).toBe("gzip");
    expect(logger.getStatus()).toMatchObject({ sent: 1, lastError: null });
    expect((await (await fetch(endpoint, request)).json())).toEqual({ accepted: 0 });
    const result = await fetch(endpoint);
    expect(result.headers.get("Content-Encoding")).toBe("gzip");
    expect(((await result.json()) as LogPage).logs[0]!.args).toEqual([payload]);
  } finally {
    logger.stop();
    await app.close();
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
