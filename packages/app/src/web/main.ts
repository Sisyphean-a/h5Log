import "./style.css";
import type {
  ClientUpdate,
  LogClient,
  LogPage,
  LogSession,
  ServiceStatus,
  StoredLog,
} from "@h5-log/sdk";
import { createInspector, messageText } from "./inspector.js";
import { createLocalHistory } from "./history.js";

const element = <T extends HTMLElement>(id: string): T =>
  document.getElementById(id) as T;
const appFilter = element<HTMLSelectElement>("app-filter");
const environment = element<HTMLSelectElement>("environment");
const level = element<HTMLSelectElement>("level");
const source = element<HTMLSelectElement>("source");
const session = element<HTMLSelectElement>("session");
const search = element<HTMLInputElement>("search");
const scrollArea = element("log-scroll");
const logsContainer = element("logs");
const older = element<HTMLButtonElement>("older");
const latest = element<HTMLButtonElement>("latest");
const inspector = createInspector(copy);
// Rule: 本地历史只做旁路持久化，实时渲染仍走 SSE；存储不可用时退回服务端窗口。
const localHistory = createLocalHistory({
  onError: (message) => notice(message, true),
});
let localMode = false;
let serverHasMore = true;
let logs: StoredLog[] = [];
let clients: LogClient[] = [];
let sessions: LogSession[] = [];
let clientKey = "";
let cursor = 0;
let serverId = "";
let evictedThroughId = 0;
let clearAfter = 0;
let historyPage = false;
let historyBefore: number | undefined;
let follow = true;
let loading = false;
let readError = false;
let total = 0;
let sessionRevision = 0;
let requestVersion = 0;
let pageController: AbortController | undefined;
let pending: StoredLog[] = [];
let pendingScoped: StoredLog[] = [];
let pendingMatchIds = new Set<number>();
let pendingEventIds = new Set<number>();
let pendingCursor = 0;
let pendingOverflow = false;
let pendingInvalidated = false;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let stream: EventSource | undefined;
let streamInitialized = false;
let serviceVersion = 0;
const controls = {
  appId: appFilter,
  environment,
  level,
  source,
  sessionId: session,
};

function notice(message: string, permanent = false): void {
  clearTimeout(noticeTimer);
  element("notice").textContent = message;
  element("notice").hidden = !message;
  if (message && !permanent)
    noticeTimer = setTimeout(() => {
      element("notice").hidden = true;
    }, 5000);
}
async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    notice("已复制");
  } catch {
    notice("复制失败，可在详情中选择内容手动复制");
  }
}
function updateOptions(
  select: HTMLSelectElement,
  values: string[],
  label: string,
): void {
  const selected = select.value;
  if (selected && !values.includes(selected)) values = [selected, ...values];
  const signature = JSON.stringify(values);
  if (select.dataset.options !== signature) {
    select.replaceChildren(
      new Option(label, ""),
      ...values.map((value) => new Option(value, value)),
    );
    select.dataset.options = signature;
  }
  select.value = selected;
}
function readLocation(): void {
  const params = new URLSearchParams(location.search);
  for (const [key, control] of Object.entries(controls)) {
    const value = params.get(key) ?? "";
    if (![...control.options].some((option) => option.value === value))
      control.add(new Option(value, value));
    control.value = value;
  }
  search.value = params.get("search") ?? "";
  clientKey = params.get("clientKey") ?? "";
}
function writeLocation(): void {
  const params = filterParams();
  params.delete("limit");
  params.delete("after");
  const query = params.toString();
  window.history.replaceState(
    null,
    "",
    `${location.pathname}${query ? `?${query}` : ""}`,
  );
}
function relativeTime(time: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  return seconds < 10
    ? "刚刚上报"
    : seconds < 60
      ? `${seconds} 秒前`
      : seconds < 3600
        ? `${Math.floor(seconds / 60)} 分钟前`
        : `${Math.floor(seconds / 3600)} 小时前`;
}
function clientLabel(client: LogClient): string {
  return (
    client.deviceName || `${client.appId} · ${client.deviceId.slice(0, 8)}`
  );
}
function clientButton(
  label: string,
  key: string,
  meta: string,
  errors = 0,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = `client${clientKey === key ? " active" : ""}`;
  button.setAttribute("aria-pressed", String(clientKey === key));
  button.dataset.clientKey = key;
  const icon = document.createElement("span");
  icon.className = "client-icon";
  icon.textContent = key ? "▯" : "◫";
  const content = document.createElement("span");
  content.className = "client-content";
  const name = document.createElement("span");
  name.className = "client-name";
  name.textContent = label;
  const detail = document.createElement("span");
  detail.className = "client-meta";
  detail.textContent = meta;
  content.append(name, detail);
  button.append(icon, content);
  if (errors) {
    const count = document.createElement("span");
    count.className = "client-errors";
    count.textContent = String(errors);
    count.title = `${errors} 条 Error`;
    button.append(count);
  }
  button.addEventListener("click", () => {
    clientKey = key;
    session.value = "";
    sessions = [];
    resetView();
    renderClients();
  });
  return button;
}
function renderClients(): void {
  const focused =
    document.activeElement instanceof HTMLElement
      ? document.activeElement.dataset.clientKey
      : undefined;
  updateOptions(
    appFilter,
    [...new Set(clients.map((client) => client.appId))].sort(),
    "全部应用",
  );
  updateOptions(
    environment,
    [...new Set(clients.map((client) => client.environment))].sort(),
    "全部环境",
  );
  const scoped = clients.filter(
    (client) =>
      (!appFilter.value || client.appId === appFilter.value) &&
      (!environment.value || client.environment === environment.value),
  );
  element("client-count").textContent = String(scoped.length);
  const nodes = [clientButton("全部客户端", "", `${scoped.length} 个客户端`)];
  for (const client of scoped)
    nodes.push(
      clientButton(
        clientLabel(client),
        client.key,
        `${client.appId} / ${client.environment} · ${relativeTime(client.lastSeen)}`,
        client.errorCount,
      ),
    );
  element("clients").replaceChildren(...nodes);
  if (focused !== undefined)
    nodes
      .find((node) => node.dataset.clientKey === focused)
      ?.focus({ preventScroll: true });
  const current = clients.find((client) => client.key === clientKey);
  element("scope-title").textContent = current
    ? clientLabel(current)
    : clientKey
      ? "客户端已过期"
      : "全部客户端";
  element("scope-detail").textContent = current
    ? `${current.appId} / ${current.environment} · ${current.deviceId} · ${relativeTime(current.lastSeen)}`
    : clientKey
      ? "此客户端的保留日志已清理"
      : scoped.length
        ? `${scoped.length} 个客户端 · ${appFilter.value || "全部应用"}`
        : "等待日志接入";
}
function filterParams(): URLSearchParams {
  const params = new URLSearchParams({ limit: "200" });
  for (const [key, control] of Object.entries(controls))
    if (control.value) params.set(key, control.value);
  if (clientKey) params.set("clientKey", clientKey);
  if (search.value.trim()) params.set("search", search.value.trim());
  if (clearAfter) params.set("after", String(clearAfter));
  return params;
}
function inScope(log: StoredLog): boolean {
  return (
    (!appFilter.value || log.appId === appFilter.value) &&
    (!environment.value || log.environment === environment.value) &&
    (!clientKey || log.clientKey === clientKey)
  );
}
function matches(log: StoredLog): boolean {
  return (
    inScope(log) &&
    (!session.value || log.sessionId === session.value) &&
    (!level.value || log.level === level.value) &&
    (!source.value || log.source === source.value) &&
    log.id > clearAfter &&
    (!search.value.trim() ||
      JSON.stringify(log.args)
        .toLocaleLowerCase()
        .includes(search.value.trim().toLocaleLowerCase()))
  );
}
function updateSessions(): void {
  const scoped = sessions.filter(
    (item) => !clientKey || item.clientKey === clientKey,
  );
  const values = [...new Set(scoped.map((item) => item.sessionId))];
  updateOptions(session, values, "全部会话");
  for (const option of [...session.options].slice(1)) {
    const item = scoped.find((item) => item.sessionId === option.value);
    option.textContent = item
      ? `${new Date(item.firstSeen).toLocaleTimeString("en-GB", { hour12: false })} · ${item.sessionId.slice(0, 8)} · ${item.logCount} 条`
      : `会话 ${option.value.slice(0, 8)}`;
  }
}
function addSessions(incoming: StoredLog[]): void {
  for (const log of incoming) {
    if (!inScope(log)) continue;
    sessionRevision++;
    const item = sessions.find(
      (item) =>
        item.clientKey === log.clientKey && item.sessionId === log.sessionId,
    );
    if (item) {
      item.lastSeen = log.receivedAt;
      item.logCount++;
      if (log.level === "error") item.errorCount++;
    } else
      sessions.unshift({
        clientKey: log.clientKey,
        sessionId: log.sessionId,
        firstSeen: log.receivedAt,
        lastSeen: log.receivedAt,
        logCount: 1,
        errorCount: log.level === "error" ? 1 : 0,
        pageUrl: log.pageUrl,
      });
  }
  updateSessions();
}
function selectLog(log: StoredLog): void {
  document
    .querySelectorAll(".log-row.selected")
    .forEach((node) => node.classList.remove("selected"));
  [...logsContainer.children]
    .find((node) => (node as HTMLElement).dataset.id === String(log.id))
    ?.classList.add("selected");
  inspector.show(log);
}
function row(log: StoredLog): HTMLDetailsElement {
  const details = document.createElement("details");
  details.className = `log-row level-${log.level}`;
  details.dataset.id = String(log.id);
  details.dataset.serverId = serverId;
  const summary = document.createElement("summary");
  const time = document.createElement("time");
  const date = new Date(log.timestamp);
  const valid = !Number.isNaN(date.getTime());
  time.dateTime = valid
    ? date.toISOString()
    : new Date(log.receivedAt).toISOString();
  time.textContent = valid
    ? `${date.toLocaleTimeString("en-GB", { hour12: false })}.${String(date.getMilliseconds()).padStart(3, "0")}`
    : "时间无效";
  time.title = `客户端 ${time.dateTime}\n接收 ${new Date(log.receivedAt).toISOString()}`;
  const client = document.createElement("span");
  client.className = "log-client";
  client.textContent =
    log.deviceName || `${log.appId} · ${log.deviceId.slice(0, 6)}`;
  client.title = `${log.appId} / ${log.deviceId}`;
  const badge = document.createElement("span");
  badge.className = "log-level";
  badge.textContent = log.level;
  const origin = document.createElement("span");
  origin.className = "log-source";
  origin.textContent =
    log.source === "error"
      ? "JS Error"
      : log.source === "http"
        ? "HTTP"
        : log.source;
  const message = document.createElement("span");
  message.className = "log-message";
  message.textContent = messageText(log);
  message.title = message.textContent;
  summary.append(time, client, badge, origin, message);
  details.append(summary);
  summary.addEventListener("click", (event) => {
    event.preventDefault();
    selectLog(log);
  });
  return details;
}
let renderScheduled = false;
/** Rule: 高频日志按帧合并渲染，避免每批 SSE 消息都重排列表与滚动。 */
function scheduleRender(): void {
  if (renderScheduled) return;
  renderScheduled = true;
  const run = (): void => {
    renderScheduled = false;
    renderLogs();
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else run();
}

function renderLogs(): void {
  const previousScroll = scrollArea.scrollTop;
  const visibleIds = new Set(logs.map((log) => log.id));
  const existing = new Map<string, HTMLDetailsElement>();
  for (const node of [...logsContainer.children] as HTMLDetailsElement[]) {
    if (
      !visibleIds.has(Number(node.dataset.id)) ||
      node.dataset.serverId !== serverId
    )
      node.remove();
    else existing.set(node.dataset.id!, node);
  }
  logs.forEach((log, index) => {
    const node = existing.get(String(log.id)) ?? row(log);
    node.classList.toggle("selected", inspector.selectedId === log.id);
    if (logsContainer.children[index] !== node)
      logsContainer.insertBefore(node, logsContainer.children[index] ?? null);
  });
  const filtered = Boolean(
    clientKey ||
    level.value ||
    source.value ||
    search.value ||
    environment.value ||
    appFilter.value ||
    session.value ||
    clearAfter,
  );
  element("empty").hidden = logs.length > 0;
  element("empty-title").textContent = readError
    ? "暂时无法读取日志"
    : loading
      ? "正在读取日志"
      : filtered
        ? "没有匹配日志"
        : "等待第一条日志";
  element("empty-message").textContent = readError
    ? "检查日志服务后点击重新读取。"
    : filtered
      ? "调整筛选条件，或等待新的日志。"
      : "接入 H5，或先用演示页发送一条日志。";
  element("empty-demo").hidden = filtered || readError;
  element("log-count").textContent = `${logs.length} 条`;
  element("scope-summary").textContent =
    `匹配 ${total.toLocaleString()} 条 · ${sessions.length} 个会话`;
  element("view-title").textContent = historyPage ? "历史日志" : "实时日志";
  element("view-state").classList.toggle("paused", historyPage);
  latest.hidden = !historyPage && !readError;
  latest.textContent = readError ? "重新读取" : "回到实时 ↓";
  element("page-note").textContent = historyPage
    ? "历史页 · 新日志仍在接收"
    : "每页最多 200 条";
  element("reset-filters").hidden = !filtered;
  for (const id of ["copy-visible", "export"])
    element<HTMLButtonElement>(id).disabled = logs.length === 0;
  element("tab-all").setAttribute(
    "aria-selected",
    String(!source.value && !level.value),
  );
  element("tab-http").setAttribute(
    "aria-selected",
    String(source.value === "http" && !level.value),
  );
  element("tab-errors").setAttribute(
    "aria-selected",
    String(level.value === "error" && !source.value),
  );
  updateSessions();
  if (follow && !historyPage) scrollArea.scrollTop = scrollArea.scrollHeight;
  else scrollArea.scrollTop = previousScroll;
}
async function refreshSessionIndex(): Promise<void> {
  const params = new URLSearchParams();
  if (appFilter.value) params.set("appId", appFilter.value);
  if (environment.value) params.set("environment", environment.value);
  if (clientKey) params.set("clientKey", clientKey);
  const scope = [appFilter.value, environment.value, clientKey].join("\u0000");
  const revision = sessionRevision;
  params.set("limit", "1");
  try {
    const response = await fetch(`/api/logs?${params}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const page = (await response.json()) as LogPage;
    if (
      scope !==
        [appFilter.value, environment.value, clientKey].join("\u0000") ||
      revision !== sessionRevision
    ) {
      if (
        scope === [appFilter.value, environment.value, clientKey].join("\u0000")
      )
        void refreshSessionIndex();
      return;
    }
    sessions = page.sessions;
    clients = page.clients;
    updateSessions();
    renderClients();
    renderLogs();
  } catch {
    notice("会话列表更新失败，请重新读取");
  }
}
async function loadPage(before?: number): Promise<void> {
  const version = ++requestVersion;
  pageController?.abort();
  pageController = new AbortController();
  loading = true;
  readError = false;
  pending = [];
  pendingScoped = [];
  pendingMatchIds = new Set();
  pendingEventIds = new Set();
  pendingCursor = 0;
  pendingOverflow = false;
  pendingInvalidated = false;
  historyPage = before !== undefined;
  historyBefore = before;
  older.disabled = true;
  const params = filterParams();
  if (before !== undefined) params.set("before", String(before));
  if (logs.length === 0) renderLogs();
  try {
    const response = await fetch(`/api/logs?${params}`, {
      signal: pageController.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const page = (await response.json()) as LogPage;
    if (version !== requestVersion) return;
    if (serverId && serverId !== page.serverId) {
      clearAfter = 0;
      cursor = 0;
      evictedThroughId = 0;
      inspector.close();
      serverId = page.serverId;
      void loadPage();
      return;
    }
    serverId = page.serverId;
    localHistory?.setServerId(page.serverId);
    localHistory?.append(page.logs);
    serverHasMore = page.hasMore;
    localMode = false;
    clients = page.clients ?? [];
    sessions = page.sessions ?? [];
    cursor = Math.max(page.cursor, pendingCursor);
    const incoming = pending.filter(
      (log) =>
        log.id > page.cursor && log.id > evictedThroughId && matches(log),
    );
    const merged = [
      ...page.logs.filter((log) => log.id > evictedThroughId),
      ...(!historyPage ? incoming : []),
    ];
    logs = merged.slice(-200);
    total =
      (page.total ?? page.logs.length) +
      [...pendingMatchIds].filter(
        (id) => id > page.cursor && id > evictedThroughId,
      ).length;
    const pendingSessionLogs = pendingScoped.filter(
      (log) => log.id > page.cursor && log.id > evictedThroughId,
    );
    addSessions(pendingSessionLogs);
    const refreshSessions = pendingOverflow;
    const overflowed = pendingOverflow;
    const refreshPage =
      pendingInvalidated ||
      pendingMatchIds.size >= 20000 ||
      pendingEventIds.size >= 20000;
    pending = [];
    pendingScoped = [];
    pendingMatchIds = new Set();
    pendingOverflow = false;
    loading = false;
    older.disabled = !page.hasMore && merged.length <= 200 && !overflowed;
    if (older.disabled) void enableLocalHistory();
    renderClients();
    renderLogs();
    notice("");
    if (refreshSessions) void refreshSessionIndex();
    if (refreshPage && (pendingInvalidated || !historyPage))
      void loadPage(historyPage ? historyBefore : undefined);
  } catch (error) {
    if (version !== requestVersion) return;
    loading = false;
    readError = true;
    notice(
      `读取失败：${error instanceof Error ? error.message : "网络错误"}。可点击“重新读取”。`,
      true,
    );
    renderLogs();
  }
}
async function enableLocalHistory(): Promise<void> {
  const oldest = logs[0];
  if (!localHistory || !oldest || localMode) return;
  const version = requestVersion;
  const has = await localHistory.hasBefore(oldest.id, matches);
  if (version !== requestVersion || loading || !has) return;
  older.disabled = false;
}

async function loadLocalPage(before: number): Promise<void> {
  const history = localHistory;
  if (!history) return;
  const version = ++requestVersion;
  loading = true;
  older.disabled = true;
  try {
    const result = await history.page({ before, limit: 200, accept: matches });
    if (version !== requestVersion) return;
    loading = false;
    if (result.logs.length === 0) {
      notice("没有更早的本地历史：只保留当前浏览器看过的日志");
      return;
    }
    logs = result.logs;
    localMode = true;
    historyPage = true;
    historyBefore = before;
    older.disabled = !result.hasMore;
    renderLogs();
    notice("本地历史：来自当前浏览器，不在服务器保留窗口内");
  } catch (error) {
    if (version !== requestVersion) return;
    loading = false;
    notice(
      `读取本地历史失败：${error instanceof Error ? error.message : "浏览器存储异常"}`,
      true,
    );
  }
}

function resetView(): void {
  clearTimeout(searchTimer);
  clearAfter = 0;
  logs = [];
  inspector.close();
  writeLocation();
  void loadPage();
}
appFilter.addEventListener("change", () => {
  clientKey = "";
  session.value = "";
  sessions = [];
  renderClients();
  resetView();
});
environment.addEventListener("change", () => {
  clientKey = "";
  session.value = "";
  sessions = [];
  renderClients();
  resetView();
});
for (const select of [level, source, session])
  select.addEventListener("change", resetView);
search.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(resetView, 200);
});
older.addEventListener("click", () => {
  const oldest = logs[0];
  if (!oldest) return;
  if (localMode || !serverHasMore) void loadLocalPage(oldest.id);
  else void loadPage(oldest.id);
});
latest.addEventListener("click", () => {
  void loadPage();
});
element("refresh").addEventListener("click", () => {
  void loadPage();
});
element("reset-filters").addEventListener("click", () => {
  for (const control of Object.values(controls)) control.value = "";
  clientKey = "";
  search.value = "";
  resetView();
  renderClients();
});
for (const [id, origin, severity] of [
  ["tab-all", "", ""],
  ["tab-http", "http", ""],
  ["tab-errors", "", "error"],
]) {
  element(id!).addEventListener("click", () => {
    source.value = origin!;
    level.value = severity!;
    resetView();
  });
}
element("follow").addEventListener("click", () => {
  follow = !follow;
  element("follow").setAttribute("aria-pressed", String(follow));
  element("follow-state").textContent = follow ? "开" : "关";
  if (follow && !historyPage) scrollArea.scrollTop = scrollArea.scrollHeight;
});
element("clear").addEventListener("click", () => {
  ++requestVersion;
  pageController?.abort();
  loading = false;
  readError = false;
  pending = [];
  pendingMatchIds = new Set();
  pendingEventIds = new Set();
  pendingScoped = [];
  clearAfter = cursor;
  logs = [];
  total = 0;
  historyPage = false;
  inspector.close();
  older.disabled = true;
  renderLogs();
});
element("copy-visible").addEventListener("click", () => {
  void copy(logs.map((log) => JSON.stringify(log)).join("\n"));
});
element("export").addEventListener("click", () => {
  const blob = new Blob([logs.map((log) => JSON.stringify(log)).join("\n")], {
    type: "application/x-ndjson;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `h5-log-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
document.addEventListener("keydown", (event) => {
  const typing =
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLSelectElement ||
    event.target instanceof HTMLTextAreaElement;
  if (event.key === "/" && !typing) {
    event.preventDefault();
    search.focus();
  }
  if (event.key === "Escape") inspector.close();
  if (
    !typing &&
    (event.key === "ArrowDown" || event.key === "ArrowUp") &&
    element("log-scroll").contains(document.activeElement)
  ) {
    const index = logs.findIndex((log) => log.id === inspector.selectedId);
    const next =
      index < 0
        ? 0
        : Math.max(
            0,
            Math.min(
              logs.length - 1,
              index + (event.key === "ArrowDown" ? 1 : -1),
            ),
          );
    if (logs[next]) {
      event.preventDefault();
      selectLog(logs[next]);
      const summary = logsContainer.children[next]?.querySelector("summary");
      summary?.focus({ preventScroll: true });
      summary?.scrollIntoView({ block: "nearest" });
    }
  }
});
function connectStream(): void {
  stream?.close();
  element("connection").className = "connection connecting";
  element("connection-text").textContent = "连接中";
  stream = new EventSource("/api/stream");
  stream.addEventListener("open", () => {
    element("connection").className = "connection";
    element("connection-text").textContent = "已连接";
  });
  stream.addEventListener("error", () => {
    element("connection").className = "connection connecting";
    element("connection-text").textContent = "重连中";
  });
  stream.addEventListener("hello", (event) => {
    try {
      const hello = JSON.parse((event as MessageEvent<string>).data) as {
        serverId: string;
        clients: LogClient[];
      };
      const reconnect = streamInitialized;
      streamInitialized = true;
      const restarted = serverId && serverId !== hello.serverId;
      if (restarted) {
        clearAfter = 0;
        cursor = 0;
        evictedThroughId = 0;
        historyPage = false;
        historyBefore = undefined;
        inspector.close();
        notice("服务器已重启，保留日志已清空");
      }
      serverId = hello.serverId;
      localHistory?.setServerId(hello.serverId);
      clients = hello.clients;
      renderClients();
      if (reconnect || restarted)
        void loadPage(historyPage ? historyBefore : undefined);
    } catch {
      notice("实时数据格式异常，请刷新页面", true);
    }
  });
  stream.addEventListener("logs", (event) => {
    try {
      const batch = JSON.parse((event as MessageEvent<string>).data) as {
        logs: StoredLog[];
        clients: LogClient[];
      };
      clients = batch.clients;
      localHistory?.append(batch.logs);
      renderClients();
      inspector.receive(batch.logs);
      const unseen = batch.logs.filter(
        (log) =>
          log.id > (loading ? Math.max(cursor, pendingCursor) : cursor) &&
          !pendingEventIds.has(log.id),
      );
      if (loading) {
        for (const log of unseen) {
          if (pendingEventIds.size < 20000) pendingEventIds.add(log.id);
          else pendingInvalidated = true;
          pendingCursor = Math.max(pendingCursor, log.id);
        }
        const scoped = unseen.filter(inScope);
        const sessionLogs = scoped.filter(
          (log) => !pendingScoped.some((item) => item.id === log.id),
        );
        const nextScoped = [...pendingScoped, ...sessionLogs];
        pendingOverflow ||=
          nextScoped.length > 200 || pendingEventIds.size > 20000;
        pendingScoped = nextScoped.slice(-200);
        const matching = scoped.filter(matches);
        for (const log of matching) {
          if (pendingMatchIds.size < 20000) pendingMatchIds.add(log.id);
          else pendingOverflow = true;
        }
        if (historyPage && matching.length > 0) {
          total += matching.length;
          scheduleRender();
        }
        const matched = [...pending, ...matching];
        pendingOverflow ||=
          matched.length > 200 || pendingMatchIds.size > 20000;
        pending = matched.slice(-200);
        return;
      }
      for (const log of unseen) {
        cursor = Math.max(cursor, log.id);
        pendingEventIds.delete(log.id);
      }
      const known = new Set(logs.map((log) => log.id));
      const scoped = unseen.filter((log) => !known.has(log.id));
      const fresh = scoped.filter(matches);
      addSessions(scoped);
      if (historyPage) {
        total += fresh.length;
        scheduleRender();
        return;
      }
      if (fresh.length === 0) return;
      total += fresh.length;
      const combined = [...logs, ...fresh];
      if (combined.length > 200) older.disabled = false;
      logs = combined.slice(-200);
      scheduleRender();
    } catch {
      notice("实时数据格式异常，请重新读取", true);
    }
  });
  stream.addEventListener("clients", (event) => {
    try {
      const update = JSON.parse(
        (event as MessageEvent<string>).data,
      ) as ClientUpdate;
      clients = update.clients;
      const cutoffChanged = update.evictedThroughId > evictedThroughId;
      evictedThroughId = Math.max(evictedThroughId, update.evictedThroughId);
      if (cutoffChanged) sessionRevision++;
      const retained = logs.filter(
        (log) =>
          log.receivedAt > update.expiresBefore && log.id > evictedThroughId,
      );
      const changed = retained.length !== logs.length;
      logs = retained;
      sessions = sessions.filter(
        (item) => item.lastSeen > update.expiresBefore,
      );
      if (
        inspector.selectedId !== undefined &&
        inspector.selectedId <= evictedThroughId
      )
        inspector.close();
      renderClients();
      updateSessions();
      if (changed) renderLogs();
      if (cutoffChanged) {
        void refreshSessionIndex();
        if (!loading) void loadPage(historyPage ? historyBefore : undefined);
        else pendingInvalidated = true;
      }
    } catch {
      notice("客户端列表更新失败");
    }
  });
}
const setupCode = `import { createLogger } from '@h5-log/sdk';\n\nexport const logger = createLogger({\n  enabled: import.meta.env.MODE === 'test',\n  appId: '26',\n  endpoint: '${location.origin}/api/logs',\n  captureFetch: true,\n  flushIntervalMs: 250,\n});`;
element("setup-code").textContent = setupCode;
element("setup").addEventListener("click", () =>
  element<HTMLDialogElement>("setup-dialog").showModal(),
);
element("copy-setup").addEventListener("click", () => {
  void copy(setupCode);
});
for (const button of document.querySelectorAll<HTMLButtonElement>(
  "[data-close]",
))
  button.addEventListener("click", () =>
    element<HTMLDialogElement>(button.dataset.close!).close(),
  );
async function loadService(): Promise<void> {
  const version = ++serviceVersion;
  const content = element("service-content");
  content.textContent = "正在读取…";
  try {
    const response = await fetch("/api/health");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const state = (await response.json()) as ServiceStatus;
    if (version !== serviceVersion) return;
    const fields: [string, string][] = [
      [
        "运行时间",
        `${Math.floor(state.uptimeSeconds / 3600)} 时 ${Math.floor(state.uptimeSeconds / 60) % 60} 分`,
      ],
      [
        "保留日志",
        `${state.logs.toLocaleString()} / ${state.limits.maxLogs.toLocaleString()} 条`,
      ],
      [
        "日志数据",
        `${(state.bytes / 1024 / 1024).toFixed(2)} / ${(state.limits.maxBytes / 1024 / 1024).toFixed(0)} MiB`,
      ],
      [
        "连接",
        `${state.clients} 个客户端 · ${state.sessions} 个会话 · ${state.subscribers} 个查看者`,
      ],
      [
        "累计接收 / 清理",
        `${state.received.toLocaleString()} / ${state.evicted.toLocaleString()} 条`,
      ],
      ["本次启动", new Date(state.startedAt).toLocaleString("zh-CN")],
    ];
    const dl = document.createElement("dl");
    dl.className = "service-fields";
    for (const [key, value] of fields) {
      const dt = document.createElement("dt");
      dt.textContent = key;
      const dd = document.createElement("dd");
      dd.textContent = value;
      dl.append(dt, dd);
    }
    content.replaceChildren(dl);
  } catch (error) {
    if (version === serviceVersion)
      content.textContent = `无法读取：${error instanceof Error ? error.message : "网络错误"}`;
  }
}
element("service").addEventListener("click", () => {
  element<HTMLDialogElement>("service-dialog").showModal();
  void loadService();
});
element("service-refresh").addEventListener("click", () => {
  void loadService();
});
window.addEventListener("popstate", () => {
  readLocation();
  logs = [];
  inspector.close();
  clearAfter = 0;
  void loadPage();
  renderClients();
});
window.addEventListener("pagehide", () => {
  stream?.close();
  pageController?.abort();
});
window.addEventListener("pageshow", (event) => {
  if (event.persisted) connectStream();
});
readLocation();
connectStream();
renderClients();
void loadPage();
