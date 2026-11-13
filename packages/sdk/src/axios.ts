import { getAdapter, isAxiosError } from "axios";
import type {
  AxiosAdapter,
  AxiosInstance,
  AxiosResponse,
  InternalAxiosRequestConfig,
} from "axios";
import type { Logger } from "./types.js";

const installations = new WeakMap<AxiosInstance, () => void>();

function readableBody(value: unknown): unknown {
  if (typeof value !== "string" || value.length > 64 * 1024) return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/**
 * Flow: 在 adapter 边界记录已变换请求和原始响应，先于业务层解包。
 * Guarantee: 不改变配置、响应或错误；日志器抛错时也继续业务调用。
 */
export function attachAxiosLogger(
  instance: AxiosInstance,
  logger: Logger,
): () => void {
  installations.get(instance)?.();
  const original = instance.defaults.adapter;
  const attachmentId =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let sequence = 0;
  function record(level: "info" | "error", data: () => unknown): void {
    try {
      logger.record("http", level, data());
    } catch {
      /* Rule: 诊断失败不能改变请求结果。 */
    }
  }
  const wrapped: AxiosAdapter = async (config: InternalAxiosRequestConfig) => {
    const requestId = `${logger.context.sessionId}:http:${attachmentId}:${++sequence}`;
    const started = Date.now();
    let url = config.url ?? "";
    try {
      url = instance.getUri(config);
    } catch {
      /* Rule: URL 格式错误交由原 adapter 处理。 */
    }
    const method = (config.method ?? "get").toUpperCase();
    record("info", () => ({
      phase: "request",
      requestId,
      method,
      url,
      headers: config.headers.toJSON(),
      body: readableBody(config.data),
    }));
    const responseData = (response: AxiosResponse): unknown => ({
      status: response.status,
      headers:
        typeof response.headers?.toJSON === "function"
          ? response.headers.toJSON()
          : response.headers,
      body: readableBody(response.data),
    });
    try {
      const response = await getAdapter(original)(config);
      record("info", () => ({
        phase: "response",
        requestId,
        method,
        url,
        durationMs: Date.now() - started,
        ...(responseData(response) as object),
      }));
      return response;
    } catch (error) {
      record("error", () => ({
        phase: "error",
        requestId,
        method,
        url,
        durationMs: Date.now() - started,
        error:
          error instanceof Error
            ? { name: error.name, message: error.message }
            : error,
        ...(isAxiosError(error) && error.response
          ? (responseData(error.response) as object)
          : {}),
      }));
      throw error;
    }
  };
  instance.defaults.adapter = wrapped;
  const detach = (): void => {
    if (instance.defaults.adapter === wrapped) {
      if (original === undefined) delete instance.defaults.adapter;
      else instance.defaults.adapter = original;
    }
    if (installations.get(instance) === detach) installations.delete(instance);
  };
  installations.set(instance, detach);
  return detach;
}
