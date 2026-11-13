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
  bridge: "桥接",
  custom: "自定义",
};

export function clientLabel(client: {
  appId: string;
  environment: string;
  deviceName: string;
  deviceId: string;
}): string {
  const name = client.deviceName || client.deviceId.slice(0, 6);
  return `${name} · ${client.appId}/${client.environment}`;
}

export function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
