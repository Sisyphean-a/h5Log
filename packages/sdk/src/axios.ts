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
 * 为已有 Axios 1.7+ 实例挂载接口采集，无需修改各处业务请求。
 * 在请求转换后、响应转换及业务解包前记录参数、正文与耗时，以 requestId 关联收发。
 * 上传由 SDK 独立完成，保持原业务响应和错误，采集失败不改变请求结果。
 *
 * 每个 Axios 实例挂载一次；重复挂载会替换上次安装。
 * 仅包装默认 adapter；单次请求自定义 adapter 不采集，更换默认 adapter 后需重新挂载。
 * 返回 detach 恢复原 adapter；停止日志采集时同时调用 detach() 和 logger.stop()。
 *
 * @example
 * import { attachAxiosLogger } from "@h5-log/sdk/axios";
 * const detach = attachAxiosLogger(axiosClient, logger);
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
