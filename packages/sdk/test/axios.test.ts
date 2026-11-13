import { describe, expect, it } from "vitest";
import axios, { AxiosError, AxiosHeaders } from "axios";
import type { AxiosAdapter, AxiosResponse } from "axios";
import { attachAxiosLogger } from "../src/axios.js";
import { snapshot } from "../src/serialize.js";
import type { Logger } from "../src/types.js";

function recorder() {
  const events: unknown[][] = [];
  const logger: Logger = {
    context: {
      appId: "26",
      environment: "test",
      deviceId: "test",
      sessionId: "session",
      deviceName: "",
      userAgent: "",
    },
    record: (...args) => {
      events.push(args.map(snapshot));
    },
    flush: async () => undefined,
    stop: () => undefined,
    getStatus: () => ({
      enabled: true,
      queued: 0,
      dropped: 0,
      lastError: null,
    }),
  };
  return { logger, events };
}

describe("Axios adapter 接入", () => {
  it("记录合并后的请求和解包前原始响应，业务仍得到原结果", async () => {
    const adapter: AxiosAdapter = async (config) => ({
      status: 200,
      statusText: "OK",
      headers: new AxiosHeaders({ "content-type": "application/json" }),
      config,
      data: '{"code":1000,"msg":"ok","data":{"id":26}}',
    });
    const client = axios.create({ baseURL: "https://business.test", adapter });
    client.interceptors.request.use((config) => {
      config.headers.set("X-Test", "fake-token");
      config.data = { ...(config.data as object), userId: "fake-user" };
      return config;
    });
    client.interceptors.response.use((response) => response.data.data);
    const { logger, events } = recorder();
    const detach = attachAxiosLogger(client, logger);
    const result = await client.post(
      "/order",
      { amount: 100 },
      { params: { app: 26 } },
    );
    expect(result).toEqual({ id: 26 });
    expect(events).toHaveLength(2);
    expect(events[0]![2]).toMatchObject({
      phase: "request",
      url: "https://business.test/order?app=26",
      headers: { "X-Test": "fake-token" },
      body: { amount: 100, userId: "fake-user" },
    });
    expect(events[1]![2]).toMatchObject({
      phase: "response",
      status: 200,
      body: { code: 1000, msg: "ok", data: { id: 26 } },
    });
    detach();
    expect(client.defaults.adapter).toBe(adapter);
  });

  it("HTTP 失败保留正文并继续抛出原错误", async () => {
    let failure: AxiosError;
    const adapter: AxiosAdapter = async (config) => {
      failure = new AxiosError(
        "failed",
        "ERR_BAD_RESPONSE",
        config,
        undefined,
        {
          config,
          status: 500,
          statusText: "Error",
          headers: new AxiosHeaders(),
          data: '{"message":"backend failed"}',
        },
      );
      throw failure;
    };
    const client = axios.create({ adapter });
    const { logger, events } = recorder();
    attachAxiosLogger(client, logger);
    await expect(client.get("/fail")).rejects.toSatisfy(
      (error) => error === failure,
    );
    expect(events[1]![2]).toMatchObject({
      phase: "error",
      status: 500,
      body: { message: "backend failed" },
    });
  });

  it("日志器故障不会改变业务请求成功与失败", async () => {
    const { logger } = recorder();
    logger.record = () => {
      throw new Error("logger failed");
    };
    const client = axios.create({
      adapter: async (config) => ({
        config,
        status: 200,
        statusText: "OK",
        headers: {},
        data: "ok",
      }),
    });
    attachAxiosLogger(client, logger);
    expect((await client.get("/ok")).data).toBe("ok");
  });

  it.each([false, true])(
    "缺少 headers 的响应仍保留成功或失败结果（失败=%s）",
    async (fail) => {
      let failure: AxiosError | undefined;
      const client = axios.create({
        adapter: async (config) => {
          const response = {
            config,
            status: fail ? 500 : 200,
            statusText: "test",
            data: "ok",
          } as AxiosResponse;
          if (fail) {
            failure = new AxiosError(
              "original failure",
              "ERR_BAD_RESPONSE",
              config,
              undefined,
              response,
            );
            throw failure;
          }
          return response;
        },
      });
      const { logger, events } = recorder();
      attachAxiosLogger(client, logger);
      const result = client.get("/without-headers");
      if (fail)
        await expect(result).rejects.toSatisfy((error) => error === failure);
      else expect((await result).data).toBe("ok");
      expect(events[1]![2]).toMatchObject({
        phase: fail ? "error" : "response",
        status: fail ? 500 : 200,
        body: "ok",
      });
    },
  );

  it("重复挂载不重复记录", async () => {
    const client = axios.create({
      adapter: async (config) => ({
        config,
        status: 200,
        statusText: "OK",
        headers: {},
        data: "ok",
      }),
    });
    const { logger, events } = recorder();
    attachAxiosLogger(client, logger);
    const detach = attachAxiosLogger(client, logger);
    await client.get("/ok");
    expect(events).toHaveLength(2);
    detach();
    await client.get("/ok");
    expect(events).toHaveLength(2);
  });
});
