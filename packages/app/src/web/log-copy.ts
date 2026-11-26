import type { JsonValue, StoredLog } from "@h5-log/sdk";
import { httpPayload, jsonText } from "./format.js";

export type LogCopyAction = {
  key: string;
  label: string;
  text: string | undefined;
  disabled: boolean;
};

export function logValueCopyText(value: JsonValue): string {
  return typeof value === "string" ? value : jsonText(value);
}

function trackingEvent(log: StoredLog): { event: string; original: string | undefined } | undefined {
  if (log.source !== "console" || typeof log.args[0] !== "string") return;
  const match = /^\[埋点\][^|]*\|\s*([a-zA-Z0-9_]+)\s*$/.exec(log.args[0].trim());
  if (!match) return;
  const event = match[1]!;
  const prefix = event.startsWith("h5_");
  const suffix = event.endsWith("_h5");
  // Rule: 只接受单一前缀或后缀，不猜测同时带两种标记的埋点。
  const original = prefix !== suffix ? (prefix ? event.slice(3) : event.slice(0, -3)) : undefined;
  return { event, original: original || undefined };
}

/** 完整正文不使用列表摘要，复制标签与实际内容保持一致。 */
export function defaultLogCopy(log: StoredLog): { text: string; label: string } {
  const original = trackingEvent(log)?.original;
  return {
    text: original ?? log.args.map(logValueCopyText).join(" "),
    label: original === undefined ? "日志内容" : "原始埋点",
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function curlText(log: StoredLog, payload: Record<string, JsonValue>): string | undefined {
  if (typeof payload.url !== "string" || !payload.url || typeof payload.method !== "string" || !payload.method) return;
  let url: URL;
  try {
    url = new URL(payload.url, log.pageUrl);
  } catch {
    return;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return;
  const parts = ["curl", "-X", shellQuote(payload.method), shellQuote(url.href)];
  const headers = payload.headers;
  if (headers && typeof headers === "object" && !Array.isArray(headers)) {
    for (const [key, value] of Object.entries(headers)) {
      if (value === null || value === false) continue;
      for (const item of Array.isArray(value) ? value : [value]) {
        parts.push("-H", shellQuote(`${key}: ${logValueCopyText(item)}`));
      }
    }
  }
  if (payload.body !== undefined && payload.body !== null) {
    parts.push("--data-raw", shellQuote(logValueCopyText(payload.body)));
  }
  return parts.join(" ");
}

export function logCopyActions(log: StoredLog): LogCopyAction[] {
  const action = (key: string, label: string, text: string | undefined): LogCopyAction => ({
    key, label, text, disabled: text === undefined,
  });
  const payload = httpPayload(log);
  if (payload && ["request", "response", "error"].includes(String(payload.phase))) {
    const request = payload.phase === "request";
    const label = request ? "请求" : "响应";
    const actions = [
      action("headers", `复制${label}头`, Object.hasOwn(payload, "headers") ? logValueCopyText(payload.headers!) : undefined),
      action("body", `复制${label}体`, Object.hasOwn(payload, "body") ? logValueCopyText(payload.body!) : undefined),
    ];
    if (request) actions.push(action("curl", "复制 cURL", curlText(log, payload)));
    return actions;
  }
  const actions = [action("copy", "复制", log.args.map(logValueCopyText).join(" "))];
  const tracking = trackingEvent(log);
  if (tracking) {
    actions.push(action("event", "复制埋点", tracking.event));
    if (tracking.original) actions.push(action("original-event", "复制原始埋点", tracking.original));
  }
  return actions;
}
