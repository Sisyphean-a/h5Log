import { describe, expect, it, vi } from "vitest";
import axios, { AxiosError, AxiosHeaders } from "axios";
import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from "axios";
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
  it.each([false, true])("禁用时直接透传，不读取诊断数据或解析正文（失败=%s）", async (fail) => {
    const body = '{"message":"disabled-body"}';
    const failure = new Error("original failure");
    const response = { data: body, status: 200, statusText: "OK", headers: {} } as AxiosResponse;
    const adapter = vi.fn(async () => {
      if (fail) throw failure;
      return response;
    });
    const client = axios.create({ adapter });
    const { logger, events } = recorder();
    logger.getStatus = () => ({ enabled: false, queued: 0, dropped: 0, lastError: null });
    const uri = vi.spyOn(client, "getUri");
    const headers = new AxiosHeaders();
    const headerRead = vi.spyOn(headers, "toJSON");
    const parse = vi.spyOn(JSON, "parse");
    const detach = attachAxiosLogger(client, logger);
    try {
      const config = { method: "post", url: "/raw", headers, data: body } as InternalAxiosRequestConfig;
      const result = axios.getAdapter(client.defaults.adapter)(config);
      if (fail) await expect(result).rejects.toBe(failure);
      else expect(await result).toBe(response);
      expect(adapter).toHaveBeenCalledExactlyOnceWith(config);
      expect(uri).not.toHaveBeenCalled();
      expect(headerRead).not.toHaveBeenCalled();
      expect(parse).not.toHaveBeenCalledWith(body);
      expect(events).toHaveLength(0);
    } finally {
      detach();
      uri.mockRestore();
      headerRead.mockRestore();
      parse.mockRestore();
    }
  });

  it("请求发出后停用采集，不再预处理响应正文", async () => {
    const body = '{"message":"response-after-stop"}';
    let enabled = true;
    const client = axios.create({ adapter: async (config) => {
      enabled = false;
      return { config, status: 200, statusText: "OK", headers: {}, data: body };
    } });
    const { logger, events } = recorder();
    logger.getStatus = () => ({ enabled, queued: 0, dropped: 0, lastError: null });
    const detach = attachAxiosLogger(client, logger);
    const parse = vi.spyOn(JSON, "parse");
    try {
      const result = await axios.getAdapter(client.defaults.adapter)({ method: "get", url: "/raw", headers: new AxiosHeaders() });
      expect(result.data).toBe(body);
      expect(parse).not.toHaveBeenCalledWith(body);
      expect(events).toHaveLength(1);
    } finally {
      detach();
      parse.mockRestore();
    }
  });

  it("状态读取失败也直接保留原业务结果", async () => {
    const response = { status: 200, data: "original" } as AxiosResponse;
    const client = axios.create({ adapter: async () => response });
    const { logger, events } = recorder();
    logger.getStatus = () => { throw new Error("status failed"); };
    const detach = attachAxiosLogger(client, logger);
    try {
      expect(await axios.getAdapter(client.defaults.adapter)({ headers: new AxiosHeaders() })).toBe(response);
      expect(events).toHaveLength(0);
    } finally {
      detach();
    }
  });
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
