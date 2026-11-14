import { computed, reactive } from "vue";
import type {
  ClientUpdate,
  LogClient,
  LogDetail,
  LogPage,
  LogSession,
  ServiceStatus,
  StoredLog,
} from "@h5-log/sdk";
import type { LocalHistory } from "./history.js";
import { requestIdOf } from "./format.js";
import { createLogMatcher, type LogFilter } from "../log-filter.js";

export type FilterState = Required<LogFilter>;

export type Connection = "connecting" | "open" | "offline";

export interface WorkbenchState {
  logs: StoredLog[];
  clients: LogClient[];
  sessions: LogSession[];
  filter: FilterState;
  total: number;
  cursor: number;
  clearAfter: number;
  evictedThroughId: number;
  serverId: string;
  serverHasMore: boolean;
  localMode: boolean;
  localHasMore: boolean;
  loading: boolean;
  reading: boolean;
  error: string;
  notice: string;
  follow: boolean;
  connection: Connection;
  streamReady: boolean;
  selectedId: number | undefined;
  detail: LogDetail | undefined;
  service: ServiceStatus | undefined;
}

export interface StreamLike {
  close(): void;
  addEventListener(type: string, listener: (event: Event) => void): void;
}

export interface WorkbenchOptions {
  fetchImpl?: typeof fetch;
  openStream?: (url: string) => StreamLike;
  history?: LocalHistory | undefined;
  onNotice?: (message: string, error?: boolean) => void;
}

const emptyFilter = (): FilterState => ({
  appId: "",
  environment: "",
  clientKey: "",
  sessionId: "",
  level: "",
  source: "",
  search: "",
});

/** Rule: 一个页面只保留一个实时工作台实例，筛选与游标状态全部集中在这里，视图只读状态。 */
export function createWorkbench(options: WorkbenchOptions = {}) {
  const fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  const history = options.history;
  const state: WorkbenchState = reactive({
    logs: [],
    clients: [],
    sessions: [],
    filter: emptyFilter(),
    total: 0,
    cursor: 0,
    clearAfter: 0,
    evictedThroughId: 0,
    serverId: "",
    serverHasMore: false,
    localMode: false,
    localHasMore: false,
    loading: false,
    reading: false,
    error: "",
    notice: "",
    follow: true,
    connection: "connecting",
    streamReady: false,
    selectedId: undefined,
    detail: undefined,
    service: undefined,
  }) as WorkbenchState;

  let stream: StreamLike | undefined;
  let pageController: AbortController | undefined;
  let requestVersion = 0;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let pending: StoredLog[] = [];
  let pendingScoped: StoredLog[] = [];
  let pendingMatchIds = new Set<number>();
  let pendingEventIds = new Set<number>();
  let pendingCursor = 0;
  let pendingOverflow = false;
  let pendingInvalidated = false;
  let historyBefore: number | undefined;
  let lifecycle: "active" | "suspended" | "disposed" = "active";
  let lifecycleVersion = 0;
  const matcher = computed(() => createLogMatcher(state.filter));

  function notice(message: string, error = false): void {
    clearTimeout(noticeTimer);
    state.notice = message;
    options.onNotice?.(message, error);
    if (message)
      noticeTimer = setTimeout(() => {
        state.notice = "";
      }, error ? 8000 : 5000);
  }

  function matches(log: StoredLog): boolean {
    return log.id > state.clearAfter && matcher.value.matches(log);
  }

  function queryParams(): URLSearchParams {
    const params = new URLSearchParams({ limit: "200" });
    const filter = state.filter;
    for (const [key, value] of Object.entries(filter))
      if (value) params.set(key, value);
    if (state.clearAfter) params.set("after", String(state.clearAfter));
    return params;
  }

  function addSessions(next: StoredLog[]): void {
    for (const log of next) {
      const existing = state.sessions.find(
        (item) => item.sessionId === log.sessionId && item.clientKey === log.clientKey,
      );
      if (existing) {
        existing.lastSeen = Math.max(existing.lastSeen, log.receivedAt);
        existing.logCount++;
        if (log.level === "error") existing.errorCount++;
      } else {
        state.sessions.push({
          clientKey: log.clientKey,
          sessionId: log.sessionId,
          firstSeen: log.receivedAt,
          lastSeen: log.receivedAt,
          logCount: 1,
          errorCount: log.level === "error" ? 1 : 0,
          pageUrl: log.pageUrl,
        });
      }
    }
  }

  async function load(before?: number): Promise<void> {
    if (lifecycle !== "active") return;
    const version = ++requestVersion;
    pageController?.abort();
    const controller = new AbortController();
    pageController = controller;
    state.loading = true;
    state.error = "";
    pending = [];
    pendingScoped = [];
    pendingMatchIds = new Set();
    pendingEventIds = new Set();
    pendingCursor = 0;
    pendingOverflow = false;
    pendingInvalidated = false;
    historyBefore = before;
    const params = queryParams();
    if (before !== undefined) params.set("before", String(before));
    try {
      const response = await fetchImpl(`/api/logs?${params}`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const page = (await response.json()) as LogPage;
      if (version !== requestVersion || lifecycle !== "active") return;
      if (state.serverId && state.serverId !== page.serverId) {
        resetForRestart(page.serverId);
        void load(before);
        return;
      }
      state.serverId = page.serverId;
      history?.setServerId(page.serverId);
      history?.append(page.logs);
      state.serverHasMore = page.hasMore;
      state.localMode = false;
      state.clients = page.clients ?? [];
      state.sessions = page.sessions ?? [];
      state.cursor = Math.max(page.cursor, pendingCursor);
      const incoming = pending.filter(
        (log) =>
          log.id > page.cursor && log.id > state.evictedThroughId && matches(log),
      );
      const merged = [
        ...page.logs.filter((log) => log.id > state.evictedThroughId),
        ...(before === undefined ? incoming : []),
      ];
      state.logs = merged.slice(-200);
      state.total =
        (page.total ?? page.logs.length) +
        [...pendingMatchIds].filter(
          (id) => id > page.cursor && id > state.evictedThroughId,
        ).length;
      const pendingSessionLogs = pendingScoped.filter(
        (log) => log.id > page.cursor && log.id > state.evictedThroughId,
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
      state.loading = false;
      state.serverHasMore = page.hasMore;
      if (!page.hasMore) void probeLocalHistory();
      notice("");
      if (refreshPage && (pendingInvalidated || before === undefined))
        void load(before);
      else if (refreshSessions) void refreshSessionsIndex();
      else if (overflowed && before !== undefined) void load(before);
    } catch (error) {
      if (version !== requestVersion || lifecycle !== "active") return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      state.loading = false;
      state.error = error instanceof Error ? error.message : "网络错误";
      notice(`读取失败：${state.error}`, true);
    }
  }

  async function probeLocalHistory(): Promise<void> {
    const oldest = state.logs[0];
    if (!history || !oldest || state.localMode) return;
    const version = requestVersion;
    const has = await history.hasBefore(oldest.id, matches);
    if (version !== requestVersion || state.loading || lifecycle !== "active") return;
    if (has) state.serverHasMore = false;
  }

  async function loadOlder(): Promise<void> {
    const oldest = state.logs[0];
    if (!oldest || state.loading) return;
    if (state.localMode || !state.serverHasMore) await loadLocal(oldest.id);
    else await load(oldest.id);
  }

  async function loadLocal(before: number): Promise<void> {
    if (!history || lifecycle !== "active") return;
    const version = ++requestVersion;
    pageController?.abort();
    state.loading = true;
    try {
      const result = await history.page({ before, limit: 200, accept: matches });
      if (version !== requestVersion || lifecycle !== "active") return;
      state.loading = false;
      if (result.logs.length === 0) {
        notice("没有更早的本地历史：只保留当前浏览器看过的日志");
        return;
      }
      state.logs = result.logs;
      state.localMode = true;
      state.localHasMore = result.hasMore;
      historyBefore = before;
      state.serverHasMore = false;
      notice("本地历史：来自当前浏览器，不在服务器保留窗口内");
    } catch (error) {
      if (version !== requestVersion) return;
      state.loading = false;
      notice(
        `读取本地历史失败：${error instanceof Error ? error.message : "浏览器存储异常"}`,
        true,
      );
    }
  }

  async function latest(): Promise<void> {
    historyBefore = undefined;
    state.localMode = false;
    await load();
  }

  function resetView(): void {
    state.logs = [];
    state.clearAfter = 0;
    state.selectedId = undefined;
    state.localMode = false;
    historyBefore = undefined;
    void load();
  }

  function setFilter(patch: Partial<FilterState>): void {
    Object.assign(state.filter, patch);
    resetView();
  }

  function setScope(patch: Partial<FilterState>): void {
    Object.assign(state.filter, patch);
    if (patch.clientKey !== undefined) state.filter.sessionId = "";
    resetView();
  }

  function clearView(): void {
    ++requestVersion;
    pageController?.abort();
    state.loading = false;
    pending = [];
    pendingMatchIds = new Set();
    pendingEventIds = new Set();
    pendingScoped = [];
    state.clearAfter = state.cursor;
    state.logs = [];
    state.total = 0;
    state.selectedId = undefined;
    state.detail = undefined;
    state.localMode = false;
  }

  function resetForRestart(serverId: string): void {
    state.clearAfter = 0;
    state.cursor = 0;
    state.evictedThroughId = 0;
    state.localMode = false;
    state.selectedId = undefined;
    state.serverId = serverId;
    notice("服务器已重启，保留日志已清空");
  }

  function handleLogs(batch: { logs: StoredLog[]; clients: LogClient[] }): void {
    if (lifecycle !== "active") return;
    state.clients = batch.clients;
    history?.append(batch.logs);
    refreshRelatedDetail(batch.logs);
    const loading = state.loading;
    const unseen = batch.logs.filter(
      (log) =>
        log.id > (loading ? Math.max(state.cursor, pendingCursor) : state.cursor) &&
        !pendingEventIds.has(log.id),
    );
    const scoped = unseen.filter(matcher.value.inScope);
    if (loading) {
      for (const log of unseen) {
        if (pendingEventIds.size < 20000) pendingEventIds.add(log.id);
        else pendingInvalidated = true;
        pendingCursor = Math.max(pendingCursor, log.id);
      }
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
      if (state.localMode && matching.length > 0) state.total += matching.length;
      const matched = [...pending, ...matching];
      pendingOverflow ||= matched.length > 200 || pendingMatchIds.size > 20000;
      pending = matched.slice(-200);
      return;
    }
    for (const log of unseen) {
      state.cursor = Math.max(state.cursor, log.id);
      pendingEventIds.delete(log.id);
    }
    const known = new Set(state.logs.map((log) => log.id));
    const sessionLogs = scoped.filter((log) => !known.has(log.id));
    const fresh = sessionLogs.filter(matches);
    addSessions(sessionLogs);
    if (state.localMode) {
      state.total += fresh.length;
      return;
    }
    if (fresh.length === 0) return;
    state.total += fresh.length;
    const combined = [...state.logs, ...fresh];
    state.logs = combined.slice(-200);
    if (state.follow && state.selectedId === undefined) {
      // 视图层负责滚动到底部
    }
  }

  function refreshRelatedDetail(incoming: StoredLog[]): void {
    const selected = state.logs.find((log) => log.id === state.selectedId);
    if (!selected) return;
    const requestId = requestIdOf(selected);
    if (!requestId) return;
    if (
      incoming.some(
        (log) =>
          log.clientKey === selected.clientKey &&
          log.sessionId === selected.sessionId &&
          requestIdOf(log) === requestId,
      )
    )
      void openDetail(selected.id);
  }

  function handleClients(update: ClientUpdate): void {
    if (lifecycle !== "active") return;
    state.clients = update.clients;
    const cutoffChanged = update.evictedThroughId > state.evictedThroughId;
    state.evictedThroughId = Math.max(
      state.evictedThroughId,
      update.evictedThroughId,
    );
    const retained = state.logs.filter(
      (log) =>
        log.receivedAt > update.expiresBefore &&
        log.id > state.evictedThroughId,
    );
    const changed = retained.length !== state.logs.length;
    state.logs = retained;
    state.sessions = state.sessions.filter(
      (item) => item.lastSeen > update.expiresBefore,
    );
    if (
      state.selectedId !== undefined &&
      state.selectedId <= state.evictedThroughId
    )
      state.selectedId = undefined;
    void changed;
    if (cutoffChanged) {
      void refreshSessionsIndex();
      if (!state.loading) void load(historyBefore);
      else pendingInvalidated = true;
    }
  }

  function handleHello(hello: { serverId: string; clients: LogClient[] }): void {
    if (lifecycle !== "active") return;
    const reconnect = state.streamReady;
    state.streamReady = true;
    if (state.serverId && state.serverId !== hello.serverId)
      resetForRestart(hello.serverId);
    state.serverId = hello.serverId;
    history?.setServerId(hello.serverId);
    state.clients = hello.clients;
    if (reconnect) reloadView();
  }

  function reloadView(): void {
    if (state.localMode && historyBefore !== undefined)
      void loadLocal(historyBefore);
    else void load(historyBefore);
  }

  async function refreshSessionsIndex(): Promise<void> {
    if (lifecycle !== "active") return;
    const version = requestVersion;
    try {
      const params = queryParams();
      params.set("limit", "1");
      const response = await fetchImpl(`/api/logs?${params}`);
      if (!response.ok) return;
      const page = (await response.json()) as LogPage;
      if (version !== requestVersion || lifecycle !== "active") return;
      state.sessions = page.sessions;
      state.clients = page.clients;
    } catch {
      if (version !== requestVersion || lifecycle !== "active") return;
      notice("日志索引更新失败，请重新读取");
    }
  }

  async function openDetail(id: number): Promise<void> {
    if (lifecycle !== "active") return;
    const generation = lifecycleVersion;
    state.selectedId = id;
    const selected = state.logs.find((log) => log.id === id);
    try {
      const response = await fetchImpl(`/api/logs/${id}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const detail = (await response.json()) as LogDetail;
      if (generation !== lifecycleVersion || state.selectedId !== id) return;
      // Rule: 数字 id 会在重启后复用，只接受同一次事件的关联记录。
      if (
        selected &&
        (detail.log.eventId !== selected.eventId ||
          detail.log.clientKey !== selected.clientKey ||
          detail.log.sessionId !== selected.sessionId)
      ) {
        notice("服务已重启，此记录不再保留", true);
        return;
      }
      state.detail = {
        log: selected ?? detail.log,
        related: detail.related,
      };
    } catch (error) {
      if (generation !== lifecycleVersion || state.selectedId !== id) return;
      notice(
        `读取详情失败：${error instanceof Error ? error.message : "记录可能已被淘汰"}`,
        true,
      );
    }
  }

  function closeDetail(): void {
    state.selectedId = undefined;
    state.detail = undefined;
  }

  async function loadService(): Promise<void> {
    if (lifecycle !== "active") return;
    const generation = lifecycleVersion;
    try {
      const response = await fetchImpl("/api/health");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const service = (await response.json()) as ServiceStatus;
      if (generation !== lifecycleVersion) return;
      state.service = service;
    } catch (error) {
      if (generation !== lifecycleVersion) return;
      notice(
        `读取服务状态失败：${error instanceof Error ? error.message : "网络错误"}`,
        true,
      );
    }
  }

  function connect(): void {
    if (lifecycle !== "active") return;
    stream?.close();
    state.connection = "connecting";
    state.streamReady = false;
    const openStream =
      options.openStream ??
      ((url: string) => new EventSource(url) as unknown as StreamLike);
    const current = openStream("/api/stream");
    stream = current;
    const listen = (type: string, listener: (event: Event) => void): void => {
      current.addEventListener(type, (event) => {
        if (lifecycle === "active" && stream === current) listener(event);
      });
    };
    listen("open", () => {
      state.connection = "open";
    });
    listen("error", () => {
      state.connection = "connecting";
    });
    listen("hello", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent<string>).data) as {
          serverId: string;
          clients: LogClient[];
        };
        handleHello(data);
      } catch {
        notice("实时数据格式异常，请刷新页面", true);
      }
    });
    listen("logs", (event) => {
      try {
        handleLogs(
          JSON.parse((event as MessageEvent<string>).data) as {
            logs: StoredLog[];
            clients: LogClient[];
          },
        );
      } catch {
        notice("实时数据格式异常，请重新读取", true);
      }
    });
    listen("clients", (event) => {
      try {
        handleClients(
          JSON.parse((event as MessageEvent<string>).data) as ClientUpdate,
        );
      } catch {
        notice("设备列表更新失败");
      }
    });
  }

  function stopIO(): void {
    ++lifecycleVersion;
    ++requestVersion;
    const previous = stream;
    stream = undefined;
    previous?.close();
    pageController?.abort();
    pageController = undefined;
    state.loading = false;
    state.connection = "offline";
    clearTimeout(noticeTimer);
  }

  return {
    state,
    matches,
    load,
    loadOlder,
    loadLocal,
    latest,
    setFilter,
    setScope,
    resetView,
    clearView,
    openDetail,
    closeDetail,
    loadService,
    refreshSessions: refreshSessionsIndex,
    connect,
    handleLogs,
    handleClients,
    handleHello,
    notice,
    suspend(): void {
      if (lifecycle !== "active") return;
      lifecycle = "suspended";
      stopIO();
    },
    resume(): void {
      if (lifecycle !== "suspended") return;
      lifecycle = "active";
      connect();
      reloadView();
    },
    dispose(): void {
      if (lifecycle === "disposed") return;
      lifecycle = "disposed";
      stopIO();
    },
  };
}

export type Workbench = ReturnType<typeof createWorkbench>;
