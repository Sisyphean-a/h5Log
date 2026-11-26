import type { JsonValue, StoredLog } from "@h5-log/sdk";

export function httpPayload(
  log: StoredLog,
): { [key: string]: JsonValue } | undefined {
  const data = log.args[0];
  return log.source === "http" &&
    data &&
    typeof data === "object" &&
    !Array.isArray(data)
    ? data
    : undefined;
}

export function requestIdOf(log: StoredLog): string | undefined {
  const payload = httpPayload(log);
  const value = log.requestId ?? payload?.requestId;
  return typeof value === "string" ? value : undefined;
}

/** Rule: 列表只展示一行摘要，完整结构留给详情面板。 */
export function messageText(log: StoredLog): string {
  const payload = httpPayload(log);
  if (payload) {
    const phase =
      payload.phase === "request" ? "→" : payload.phase === "response" ? "←" : "×";
    const status = typeof payload.status === "number" ? ` · ${payload.status}` : "";
    const duration =
      typeof payload.durationMs === "number" ? ` · ${payload.durationMs} ms` : "";
    return `${phase} ${payload.method ?? ""} ${payload.url ?? ""}${status}${duration}`;
  }
  return log.args
    .map((value) =>
      typeof value === "string"
        ? value
        : value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            typeof value.stack === "string" &&
            typeof value.name === "string"
          ? `${value.name}: ${value.message}`
          : JSON.stringify(value),
    )
    .join(" ");
}

export function formatTime(value: number): string {
  const date = new Date(value);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

export function formatDateTime(value: number): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${formatTime(value)}`;
}

export function relativeTime(value: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - value) / 1000));
  if (seconds < 5) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

export const levelLabels: Record<string, string> = {
  debug: "调试",
  info: "信息",
  log: "日志",
  warn: "警告",
  error: "错误",
};

export const sourceLabels: Record<string, string> = {
  console: "控制台",
  error: "异常",
  http: "接口",
  custom: "自定义",
};

export function clientLabel(client: {
  appId: string;
  environment: string;
  deviceName: string;
  deviceId: string;
}): string {
  const name = client.deviceName || `设备 ${client.deviceId.slice(0, 6)}`;
  return `${name} · ${client.appId}/${client.environment}`;
}

export function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function parseJsonStructure(text: string): object | undefined {
  const value = text.trim();
  if (value[0] !== "{" && value[0] !== "[") return undefined;
  try {
    return JSON.parse(value) as object;
  } catch {
    // Rule: 普通文本或不完整 JSON 不是解析错误，展示时保留原文。
    return undefined;
  }
}

/** Rule: 只在阅读视图展开完整的对象/数组字符串，不改变日志与复制数据。 */
export function jsonDisplayText(value: unknown): string {
  const pretty = (item: unknown): string => JSON.stringify(
    item,
    (_key, child: unknown) => typeof child === "string"
      ? parseJsonStructure(child) ?? child
      : child,
    2,
  ) ?? String(item);

  if (typeof value !== "string") return pretty(value);
  // Rule: 最多尝试首个对象和数组起点，支持日志前缀，避免逐字符试解析。
  const starts = [...new Set([value.indexOf("{"), value.indexOf("[")])]
    .filter((index) => index >= 0)
    .sort((a, b) => a - b);
  for (const start of starts) {
    const parsed = parseJsonStructure(value.slice(start));
    if (parsed !== undefined) {
      const prefix = value.slice(0, start).trimEnd();
      return prefix ? `${prefix}\n${pretty(parsed)}` : pretty(parsed);
    }
  }
  return value;
}

export type JsonTokenKind = "key" | "string" | "number" | "literal" | "punct" | "plain";

export interface JsonToken {
  kind: JsonTokenKind;
  text: string;
}

const JSON_ESCAPE = /^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/;

/**
 * Rule: 对展示文本做词法高亮；不做 HTML 拼接，渲染层用文本节点。
 * Failure: 超过字符或词法项上限时仅返回纯文本，限制渲染节点数。
 */
export function jsonTokens(text: string, limit = 20000, tokenLimit = Infinity): JsonToken[] {
  if (text.length > limit) return [{ kind: "plain", text }];
  const tokens: JsonToken[] = [];
  let index = 0;
  let plainStart = 0;
  const flushPlain = (end: number): void => {
    if (end > plainStart) tokens.push({ kind: "plain", text: text.slice(plainStart, end) });
  };
  const push = (kind: JsonTokenKind, end: number): void => {
    flushPlain(index);
    tokens.push({ kind, text: text.slice(index, end) });
    index = end;
    plainStart = end;
  };

  while (index < text.length) {
    if (tokens.length >= tokenLimit) return [{ kind: "plain", text }];
    const char = text[index]!;
    if (char === '"') {
      let end = index + 1;
      while (end < text.length) {
        if (text[end] === "\\") {
          end += 2;
          continue;
        }
        if (text[end] === '"') {
          end += 1;
          break;
        }
        end += 1;
      }
      let next = end;
      while (next < text.length && /\s/.test(text[next]!)) next += 1;
      push(text[next] === ":" ? "key" : "string", end);
      continue;
    }
    if (char === "-" || (char >= "0" && char <= "9")) {
      const match = JSON_ESCAPE.exec(text.slice(index));
      if (match) {
        push("number", index + match[0].length);
        continue;
      }
    }
    const literal = ["true", "false", "null"].find((item) =>
      text.startsWith(item, index),
    );
    if (literal) {
      push("literal", index + literal.length);
      continue;
    }
    if ("{}[],:".includes(char)) {
      push("punct", index + 1);
      continue;
    }
    index += 1;
  }
  flushPlain(text.length);
  return tokens.length > tokenLimit ? [{ kind: "plain", text }] : tokens;
}
