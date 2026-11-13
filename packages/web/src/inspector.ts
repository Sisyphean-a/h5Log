import type { JsonValue, LogDetail, StoredLog } from "@h5-log/sdk";

export function messageText(log: StoredLog): string {
  const payload = httpPayload(log);
  if (payload) {
    const phase =
      payload.phase === "request"
        ? "→"
        : payload.phase === "response"
          ? "←"
          : "×";
    return `${phase} ${payload.method ?? ""} ${payload.url ?? ""}${payload.status ? ` · ${payload.status}` : ""}${typeof payload.durationMs === "number" ? ` · ${payload.durationMs} ms` : ""}`;
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

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text = "",
  className = "",
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.textContent = text;
  element.className = className;
  return element;
}
function preview(value: JsonValue): string {
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (value && typeof value === "object")
    return `{ ${Object.keys(value).slice(0, 4).join(", ")}${Object.keys(value).length > 4 ? ", …" : ""} }`;
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}
/** Rule: 大对象按需展开，用户未展开的分支不创建整棵 DOM。 */
function tree(value: JsonValue, key = "", depth = 0): HTMLElement {
  if (value !== null && typeof value === "object") {
    const details = node("details", "", "json-branch");
    const summary = node("summary");
    if (key) summary.append(node("span", `${key}: `, "json-key"));
    summary.append(node("span", preview(value), "json-preview"));
    details.append(summary);
    let built = false;
    const build = (): void => {
      if (built) return;
      built = true;
      const children = node("div", "", "json-children");
      for (const [name, child] of Object.entries(value))
        children.append(tree(child, name, depth + 1));
      if (Object.keys(value).length === 0)
        children.append(node("span", "空", "muted"));
      details.append(children);
    };
    details.addEventListener("toggle", () => {
      if (details.open) build();
    });
    if (depth === 0) {
      details.open = true;
      build();
    }
    return details;
  }
  const row = node("div", "", `json-value json-${typeof value}`);
  if (key) row.append(node("span", `${key}: `, "json-key"));
  row.append(node("span", preview(value)));
  return row;
}
function block(title: string, value: JsonValue): HTMLElement {
  const section = node("section", "", "detail-section");
  section.append(node("h3", title), tree(value));
  return section;
}
function timestamp(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "无效客户端时间"
    : date.toLocaleString("zh-CN", { hour12: false });
}

export function createInspector(copy: (text: string) => Promise<void>) {
  const element = (id: string) => document.getElementById(id)!;
  let current: StoredLog | undefined;
  let related: StoredLog[] = [];
  let raw = false;
  let controller: AbortController | undefined;
  let version = 0;
  function render(): void {
    if (!current) return;
    const log = current;
    element("inspector").hidden = false;
    element("detail-kind").textContent =
      log.source === "http"
        ? "网络请求"
        : log.source === "error"
          ? "JavaScript 异常"
          : "日志详情";
    const title = node("h2", messageText(log));
    title.title = messageText(log);
    const badge = node(
      "span",
      log.level.toUpperCase(),
      `detail-level level-${log.level}`,
    );
    element("detail-heading").replaceChildren(badge, title);
    const fields = [
      [
        "客户端",
        `${log.deviceName || log.deviceId.slice(0, 8)} · ${log.appId}`,
      ],
      ["时间", timestamp(log.timestamp)],
      ["接收", timestamp(log.receivedAt)],
      ["页面", log.pageUrl],
      ["会话", log.sessionId],
    ];
    const dl = node("dl");
    for (const [label, value] of fields)
      dl.append(node("dt", label), node("dd", value));
    element("detail-meta").replaceChildren(dl);
    element("detail-structured").setAttribute("aria-selected", String(!raw));
    element("detail-raw").setAttribute("aria-selected", String(raw));
    const content = element("detail-content");
    content.replaceChildren();
    const events: StoredLog[] = [log];
    for (const item of related) {
      if (
        item.clientKey === log.clientKey &&
        item.sessionId === log.sessionId &&
        !events.some((existing) => existing.id === item.id)
      )
        events.push(item);
    }
    const rawLog = { log, related: events.slice(1) };
    if (raw) {
      content.append(node("pre", JSON.stringify(rawLog, null, 2), "raw-json"));
      return;
    }
    if (httpPayload(log) || log.requestId) {
      events.sort((a, b) => a.id - b.id);
      for (const event of events.filter((item) => !httpPayload(item)?.phase))
        content.append(block("内容已截断", event.args));
      for (const phase of ["request", "response", "error"]) {
        for (const event of events.filter(
          (item) => httpPayload(item)?.phase === phase,
        )) {
          const payload = httpPayload(event)!;
          const title =
            phase === "request"
              ? "请求"
              : phase === "error"
                ? "请求失败"
                : "响应";
          content.append(block(title, payload));
        }
      }
      const phases = events.map((item) => httpPayload(item)?.phase);
      if (!phases.includes("request"))
        content.append(node("p", "请求记录未保留", "detail-hint"));
      if (!phases.includes("response") && !phases.includes("error"))
        content.append(node("p", "尚未收到响应记录", "detail-hint"));
    } else {
      log.args.forEach((value, index) =>
        content.append(
          block(log.args.length === 1 ? "内容" : `参数 ${index + 1}`, value),
        ),
      );
    }
  }
  async function refresh(): Promise<void> {
    if (!current) return;
    controller?.abort();
    controller = new AbortController();
    const requestVersion = ++version;
    const selected = current;
    element("detail-state").textContent = "正在读取关联记录…";
    try {
      const response = await fetch(`/api/logs/${selected.id}`, {
        signal: controller.signal,
      });
      if (requestVersion !== version) return;
      if (response.status === 404) {
        element("detail-state").textContent =
          "此记录已过期或被淘汰，当前显示已读取的内容。";
        return;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const detail = (await response.json()) as LogDetail;
      if (requestVersion !== version) return;
      // Rule: 数字 id 会在重启后复用，不能把另一次页面的事件拼进详情。
      if (
        detail.log.eventId !== selected.eventId ||
        detail.log.clientKey !== selected.clientKey ||
        detail.log.sessionId !== selected.sessionId
      ) {
        element("detail-state").textContent = "服务已重启，此记录不再保留。";
        return;
      }
      related = detail.related;
      element("detail-state").textContent = "";
      render();
    } catch (error) {
      if (requestVersion !== version || controller.signal.aborted) return;
      element("detail-state").textContent =
        `读取失败：${error instanceof Error ? error.message : "网络错误"}。点击日志可重试。`;
    }
  }
  function close(): void {
    controller?.abort();
    ++version;
    current = undefined;
    related = [];
    element("inspector").hidden = true;
    document
      .querySelectorAll(".log-row.selected")
      .forEach((row) => row.classList.remove("selected"));
  }
  element("close-detail").addEventListener("click", close);
  element("copy-detail").addEventListener("click", () => {
    if (current) void copy(JSON.stringify({ log: current, related }, null, 2));
  });
  element("detail-structured").addEventListener("click", () => {
    raw = false;
    render();
  });
  element("detail-raw").addEventListener("click", () => {
    raw = true;
    render();
  });
  return {
    show(log: StoredLog) {
      current = log;
      related = [];
      raw = false;
      render();
      void refresh();
    },
    close,
    get selectedId() {
      return current?.id;
    },
    receive(incoming: StoredLog[]) {
      if (!current) return;
      const selected = current;
      const requestId = selected.requestId ?? httpPayload(selected)?.requestId;
      if (
        typeof requestId === "string" &&
        incoming.some(
          (log) =>
            log.clientKey === selected.clientKey &&
            log.sessionId === selected.sessionId &&
            (log.requestId ?? httpPayload(log)?.requestId) === requestId,
        )
      )
        void refresh();
    },
  };
}
