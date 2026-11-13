import { snapshot } from "./serialize.js";
import type { Logger } from "./types.js";

const MAX_BODY = 64 * 1024;
const installations = new WeakMap<object, () => void>();
/** Rule: 只读取克隆流的有限前缀，不消费业务流，不等待日志完成才返回响应。 */
async function bodySnapshot(
  body: ReadableStream<Uint8Array> | null,
): Promise<unknown> {
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  let timedOut = false;
  const timeout = setTimeout(() => {
    truncated = true;
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  }, 5000);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.length, MAX_BODY - size);
      chunks.push(value.subarray(0, take));
      size += take;
      if (size >= MAX_BODY) {
        truncated = true;
        void reader.cancel().catch(() => undefined);
        break;
      }
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const text = new TextDecoder().decode(bytes);
    if (truncated)
      return {
        truncated: true,
        reason: timedOut ? "正文采集超时" : "正文采集超过 64 KiB",
        preview: text,
      };
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  } finally {
    clearTimeout(timeout);
  }
}

/** Effect: 包装 fetch；返回原 Response，失败抛出原错误，卸载时只恢复自己的包装。 */
export function attachFetchLogger(
  logger: Logger,
  target: Pick<typeof globalThis, "fetch"> = globalThis,
): () => void {
  installations.get(target)?.();
  const original = target.fetch;
  let sequence = 0;
  const attachmentId =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const record = (
    level: "info" | "error" | "warn",
    data: () => unknown,
  ): void => {
    try {
      logger.record("http", level, data());
    } catch {
      /* Rule: 采集失败不改变业务调用。 */
    }
  };
  const wrapped: typeof fetch = function (input, init) {
    let requestId: string;
    try {
      if (!logger.getStatus().enabled)
        return original.call(target, input, init);
      requestId = `${logger.context.sessionId}:fetch:${attachmentId}:${++sequence}`;
    } catch {
      return original.call(target, input, init);
    }
    const started = Date.now();
    let method = "GET";
    let url = "";
    try {
      url = input instanceof Request ? input.url : String(input);
      method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined),
      );
      let body: unknown = null;
      try {
        const value = init?.body;
        const source = value ?? null;
        if (typeof value === "string" && value.length > MAX_BODY)
          body = { truncated: true, preview: value.slice(0, MAX_BODY) };
        else if (typeof value === "string") body = parse(value);
        else if (source === null && input instanceof Request && input.body)
          body = "[Request 流正文未采集]";
        else if (source instanceof ReadableStream) body = "[流正文未采集]";
        else if (source instanceof Blob)
          body = {
            type: source.type,
            size: source.size,
            data: "[Blob 正文未采集]",
          };
        else if (source instanceof URLSearchParams) body = source.toString();
        else if (source instanceof FormData)
          body = Array.from(source, ([name, item]) => ({
            name,
            value:
              typeof item === "string"
                ? item
                : { file: item.name, type: item.type, size: item.size },
          }));
        else if (source instanceof ArrayBuffer || ArrayBuffer.isView(source))
          body = `[二进制正文 ${source.byteLength} 字节未采集]`;
        else if (source !== null && source !== undefined)
          body = snapshot(source);
        record("info", () => ({
          phase: "request",
          requestId,
          method,
          url,
          headers: Object.fromEntries(headers),
          body,
        }));
      } catch {
        /* Rule: 请求流克隆失败时仍发送原始请求。 */
      }
    } catch {
      /* Rule: 非法输入交由原 fetch 处理。 */
    }
    let promise: Promise<Response>;
    try {
      promise = original.call(target, input, init);
    } catch (error) {
      record("error", () => ({
        phase: "error",
        requestId,
        method,
        url,
        error,
      }));
      throw error;
    }
    return promise.then(
      (response) => {
        try {
          const base = {
            phase: "response",
            requestId,
            method,
            url,
            status: response.status,
            durationMs: Date.now() - started,
          };
          const type = response.headers.get("content-type") ?? "";
          const headers = Object.fromEntries(response.headers);
          if (
            type.includes("text/event-stream") ||
            !/json|text|xml|javascript|x-www-form-urlencoded/i.test(type)
          ) {
            record(response.ok ? "info" : "error", () => ({
              ...base,
              headers,
              body: "[流或二进制正文未采集]",
            }));
          } else {
            void bodySnapshot(response.clone().body)
              .then((body) => {
                record(response.ok ? "info" : "error", () => ({
                  ...base,
                  headers,
                  body,
                }));
              })
              .catch(() =>
                record("warn", () => ({
                  ...base,
                  headers,
                  body: "[正文采集失败]",
                })),
              );
          }
        } catch {
          record("warn", () => ({
            phase: "response",
            requestId,
            method,
            url,
            body: "[响应采集失败]",
          }));
        }
        return response;
      },
      (error) => {
        record("error", () => ({
          phase: "error",
          requestId,
          method,
          url,
          durationMs: Date.now() - started,
          error,
        }));
        throw error;
      },
    );
  };
  target.fetch = wrapped;
  const detach = (): void => {
    if (target.fetch === wrapped) target.fetch = original;
    if (installations.get(target) === detach) installations.delete(target);
  };
  installations.set(target, detach);
  return detach;
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
