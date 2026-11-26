import { computed, reactive, shallowRef } from "vue";
import type {
  ClientUpdate,
  LogClient,
  LogDetail,
  LogPage,
  LogSession,
  StoredLog,
} from "@h5-log/sdk";
import { RESOURCE_INTERVAL_MS, type WorkbenchServiceStatus } from "../service-status.js";
import type { LocalHistory } from "./history.js";
import { requestIdOf } from "./format.js";
import { createLogMatcher, LOG_WINDOW_SIZE, type LogFilter } from "../log-filter.js";

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
  service: WorkbenchServiceStatus | undefined;
  serviceError: string;
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
    // Rule: 日志正文是只读快照，只跟踪窗口替换，避免搜索遍历深层响应式代理。
    logs: shallowRef<StoredLog[]>([]),
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
    serviceError: "",
  }) as WorkbenchState;

  let stream: StreamLike | undefined;
  let streamTimer: ReturnType<typeof setTimeout> | undefined;
  let serviceVisible = false;
  let serviceTimer: ReturnType<typeof setTimeout> | undefined;
  let serviceController: AbortController | undefined;
  let pageController: AbortController | undefined;
  let requestVersion = 0;
  let sessionCursor = 0;
  let sessionRevision = 0;
  let latestRetention: ClientUpdate | undefined;
  let indexRead: { version: number; controller: AbortController; promise: Promise<void> } | undefined;
  const reads = new Set<AbortController>();
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let pending: StoredLog[] = [];
  let pendingScoped: StoredLog[] = [];
  let pendingMatchIds = new Set<number>();
  let pendingEventIds = new Set<number>();
  let pendingCursor = 0;
  let pendingOverflow = false;
  let pendingInvalidated = false;
  let historyBefore: number | undefined;
  let pageVisible = true;
  let backgroundLogs: StoredLog[] | undefined;
  let lifecycle: "active" | "suspended" | "disposed" = "active";
  let lifecycleVersion = 0;
  const matcher = computed(() => createLogMatcher(state.filter));

  function keepReadingWindow(): boolean {
    return pageVisible && !state.follow && !state.localMode && state.logs.length > 0;
  }

  function updateWindow(logs: StoredLog[], automatic = false): void {
    // Rule: 暂停只固定前台的阅读快照，实时窗口仍限长并继续接受淘汰。
    if (automatic && keepReadingWindow()) {
      backgroundLogs = logs;
    } else {
      backgroundLogs = undefined;
      state.logs = logs;
    }
  }

  function clearEvictedSelection(): void {
    if (state.selectedId !== undefined && state.selectedId <= state.evictedThroughId)
      state.selectedId = undefined;
  }

  function releaseReadingWindow(): void {
    if (!backgroundLogs) return;
    updateWindow(backgroundLogs);
    clearEvictedSelection();
  }

  function setFollowing(follow: boolean): void {
    state.follow = follow;
    if (follow) releaseReadingWindow();
  }

  function setPageVisible(visible: boolean): void {
    pageVisible = visible;
    if (!visible) releaseReadingWindow();
  }

  function notice(message: string, error = false): void {
    clearTimeout(noticeTimer);
    state.notice = message;
    options.onNotice?.(message, error);
    if (message)
      noticeTimer = setTimeout(() => {
        state.notice = "";
      }, error ? 8000 : 5000);
  }

  async function readJson<T>(url: string, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    reads.add(controller);
    const relay = (): void => controller.abort(signal?.reason);
    if (signal?.aborted) relay();
    else signal?.addEventListener("abort", relay, { once: true });
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(controller.signal.reason);
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    const timer = setTimeout(() => controller.abort(new Error("请求超时（10 秒）")), 10000);
    try {
      return await Promise.race([
        (async () => {
          if (controller.signal.aborted) throw controller.signal.reason;
          const response = await fetchImpl(url, { signal: controller.signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return await response.json() as T;
        })(),
        cancelled,
      ]);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      signal?.removeEventListener("abort", relay);
      reads.delete(controller);
    }
  }

  function matches(log: StoredLog): boolean {
    return log.id > state.clearAfter && matcher.value.matches(log);
  }

  function queryParams(): URLSearchParams {
    const params = new URLSearchParams({ limit: String(LOG_WINDOW_SIZE) });
    const filter = state.filter;
    for (const [key, value] of Object.entries(filter))
      if (value) params.set(key, value);
    if (state.clearAfter) params.set("after", String(state.clearAfter));
    return params;
  }

  function addSessions(next: StoredLog[]): void {
    let cursor = sessionCursor;
    for (const log of next) {
      if (log.id <= sessionCursor) continue;
      cursor = Math.max(cursor, log.id);
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
    sessionCursor = cursor;
  }

  function retentionChangesSessions(update: ClientUpdate): boolean {
    const expected = update.clients.reduce((total, client) =>
      matcher.value.inScope({ appId: client.appId, environment: client.environment, clientKey: client.key })
        ? total + client.logCount : total, 0);
    return expected !== state.sessions.reduce((total, session) => total + session.logCount, 0);
  }

  async function load(before?: number, automatic = false): Promise<void> {
    if (lifecycle !== "active") return;
    const previousBefore = historyBefore;
    const previousCursor = state.cursor;
    const evictionAtStart = state.evictedThroughId;
    const version = ++requestVersion;
    indexRead?.controller.abort();
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
      const page = await readJson<LogPage>(`./api/logs?${params}`, controller.signal);
      if (version !== requestVersion || lifecycle !== "active") return;
      if (state.serverId && state.serverId !== page.serverId) {
        resetForRestart(page.serverId);
        void load();
        return;
      }
      state.serverId = page.serverId;
      history?.setServerId(page.serverId);
      history?.append(page.logs);
      const emptyEarlier = before !== undefined && page.logs.length === 0;
      if (emptyEarlier) historyBefore = previousBefore;
      state.localMode = false;
      state.localHasMore = false;
      state.clients = page.clients ?? [];
      state.sessions = page.sessions ?? [];
      sessionCursor = page.cursor;
      state.cursor = Math.max(page.cursor, pendingCursor);
      const incoming = pending.filter(
        (log) =>
          log.id > (emptyEarlier ? previousCursor : page.cursor) &&
          log.id > state.evictedThroughId && matches(log),
      );
      // Rule: 空历史快照不含缓冲行，保留实时页时不能按快照游标丢掉这些行。
      const merged = [
        ...(emptyEarlier ? (backgroundLogs ?? state.logs) : page.logs).filter((log) => log.id > state.evictedThroughId),
        ...(historyBefore === undefined ? incoming : []),
      ];
      updateWindow(merged.slice(-LOG_WINDOW_SIZE), automatic || emptyEarlier);
      state.total =
        (page.total ?? page.logs.length) +
        [...pendingMatchIds].filter(
          (id) => id > page.cursor && id > state.evictedThroughId,
        ).length;
      const pendingSessionLogs = pendingScoped.filter(
        (log) => log.id > page.cursor && log.id > state.evictedThroughId,
      );
      addSessions(pendingSessionLogs);
      const refreshSessions = pendingOverflow || (state.evictedThroughId > evictionAtStart &&
        latestRetention !== undefined && retentionChangesSessions(latestRetention));
      const invalidatedPage = state.evictedThroughId > evictionAtStart &&
        page.logs.some((log) => log.id <= state.evictedThroughId);
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
      state.serverHasMore = page.hasMore || merged.length > LOG_WINDOW_SIZE;
      if (!state.serverHasMore) void probeLocalHistory();
      notice(emptyEarlier
        ? "没有更早的服务端日志，已保留当前页"
        : before !== undefined ? "正在查看更早日志，点击“最新”返回实时" : "");
      if (invalidatedPage || (refreshPage && (pendingInvalidated || historyBefore === undefined)))
        void load(historyBefore, automatic);
      else if (refreshSessions) void refreshSessionsIndex();
      else if (overflowed && historyBefore !== undefined) void load(historyBefore, automatic);
    } catch (error) {
      if (version !== requestVersion || lifecycle !== "active") return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      state.loading = false;
      historyBefore = previousBefore;
      const buffered = [...new Map([...pendingScoped, ...pending].map((log) => [log.id, log])).values()]
        .sort((a, b) => a.id - b.id);
      pending = [];
      pendingScoped = [];
      pendingMatchIds = new Set();
      pendingEventIds = new Set();
      pendingCursor = 0;
      pendingOverflow = false;
      handleLogs({ logs: buffered, clients: state.clients });
      state.error = error instanceof Error ? error.message : "网络错误";
      notice(`读取失败：${state.error}`, true);
    }
  }

  async function probeLocalHistory(): Promise<void> {
    const oldest = state.logs[0];
    if (!history || !oldest || state.localMode) return;
    const version = requestVersion;
    try {
      const has = await history.hasBefore(oldest.id, matches);
      if (version !== requestVersion || state.loading || lifecycle !== "active") return;
      state.localHasMore = has;
    } catch (error) {
      if (version !== requestVersion || lifecycle !== "active") return;
      state.localHasMore = false;
      notice(`本地历史读取失败：${error instanceof Error ? error.message : "存储异常"}`, true);
    }
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
      const result = await history.page({ before, limit: LOG_WINDOW_SIZE, accept: matches });
      if (version !== requestVersion || lifecycle !== "active") return;
      state.loading = false;
      if (result.logs.length === 0) {
        state.localHasMore = false;
        notice("没有更早的本地历史，已保留当前页");
        return;
      }
      updateWindow(result.logs);
      state.localMode = true;
      state.localHasMore = result.hasMore;
      historyBefore = before;
      state.serverHasMore = false;
      notice("正在查看本地历史，点击“最新”返回实时日志");
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

  function resetView(keepLogs = false): void {
    updateWindow(keepLogs ? state.logs : []);
    state.clearAfter = 0;
    state.selectedId = undefined;
    state.localMode = false;
    historyBefore = undefined;
    void load();
  }

  function streamQuery(): string {
    const params = new URLSearchParams();
    for (const key of ["appId", "environment", "clientKey"] as const)
      if (state.filter[key]) params.set(key, state.filter[key]);
    return params.toString();
  }

  function setFilter(patch: Partial<FilterState>): void {
    const previousScope = streamQuery();
    Object.assign(state.filter, patch);
    if (stream && previousScope !== streamQuery()) {
      state.streamReady = false;
      connect();
    }
    // Rule: 同设备筛选保留当前页供即时预览；切换设备才清空旧范围。
    resetView(previousScope === streamQuery());
  }

  function setScope(patch: Partial<FilterState>): void {
    setFilter({ ...patch, ...(patch.clientKey !== undefined ? { sessionId: "" } : {}) });
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
    updateWindow([]);
    state.total = 0;
    state.selectedId = undefined;
    state.detail = undefined;
    state.localMode = false;
  }

  function resetForRestart(serverId: string): void {
    updateWindow([]);
    state.detail = undefined;
    state.total = 0;
    state.serverHasMore = false;
    state.localHasMore = false;
    historyBefore = undefined;
    state.clearAfter = 0;
    state.cursor = 0;
    state.evictedThroughId = 0;
    sessionCursor = 0;
    sessionRevision++;
    latestRetention = undefined;
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
    if (scoped.some((log) => log.id > sessionCursor)) sessionRevision++;
    if (loading) {
      for (const log of unseen) {
        if (pendingEventIds.size < 20000) pendingEventIds.add(log.id);
        else pendingInvalidated = true;
        pendingCursor = Math.max(pendingCursor, log.id);
      }
      const nextScoped = [...pendingScoped, ...scoped];
      pendingOverflow ||=
        nextScoped.length > LOG_WINDOW_SIZE || pendingEventIds.size > 20000;
      pendingScoped = nextScoped.slice(-LOG_WINDOW_SIZE);
      const matching = scoped.filter(matches);
      for (const log of matching) {
        if (pendingMatchIds.size < 20000) pendingMatchIds.add(log.id);
        else pendingOverflow = true;
      }
      if (state.localMode && matching.length > 0) state.total += matching.length;
      const matched = [...pending, ...matching];
      pendingOverflow ||= matched.length > LOG_WINDOW_SIZE || pendingMatchIds.size > 20000;
      pending = matched.slice(-LOG_WINDOW_SIZE);
      return;
    }
    for (const log of unseen) {
      state.cursor = Math.max(state.cursor, log.id);
      pendingEventIds.delete(log.id);
    }
    const liveLogs = backgroundLogs ?? state.logs;
    const known = new Set(liveLogs.map((log) => log.id));
    const sessionLogs = scoped.filter((log) => !known.has(log.id));
    const fresh = sessionLogs.filter(matches);
    addSessions(sessionLogs);
    if (state.localMode) {
      state.total += fresh.length;
      return;
    }
    if (fresh.length === 0) return;
    state.total += fresh.length;
    const combined = [...liveLogs, ...fresh];
    updateWindow(combined.slice(-LOG_WINDOW_SIZE), true);
    if (combined.length > LOG_WINDOW_SIZE) state.serverHasMore = true;
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
    latestRetention = update;
    const liveLogs = backgroundLogs ?? state.logs;
    const cutoffChanged = update.evictedThroughId > state.evictedThroughId;
    state.evictedThroughId = Math.max(
      state.evictedThroughId,
      update.evictedThroughId,
    );
    // Rule: 服务端淘汰只约束实时窗口；本地存档由浏览器自身的缓存容量管理。
    let removedRows = false;
    if (!state.localMode) {
      const retained = liveLogs.filter(
        (log) => log.receivedAt > update.expiresBefore && log.id > state.evictedThroughId,
      );
      removedRows = retained.length < liveLogs.length;
      if (removedRows) updateWindow(retained, true);
      if (!keepReadingWindow()) clearEvictedSelection();
    }
    state.sessions = state.sessions.filter(
      (item) => item.lastSeen > update.expiresBefore,
    );
    if (cutoffChanged) {
      const changedSessions = retentionChangesSessions(update);
      if (removedRows || changedSessions) sessionRevision++;
      // Rule: 受影响列表的补读已经包含索引；无关设备的淘汰不制造查询。
      if (state.loading) return;
      if (removedRows) void load(historyBefore, true);
      else if (changedSessions) void refreshSessionsIndex();
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
    else void load(historyBefore, true);
  }

  function refreshSessionsIndex(): Promise<void> {
    if (lifecycle !== "active") return Promise.resolve();
    if (indexRead?.version === requestVersion) return indexRead.promise;
    indexRead?.controller.abort();
    const current = { version: requestVersion, controller: new AbortController(), promise: Promise.resolve() };
    indexRead = current;
    current.promise = (async () => {
      try {
        while (lifecycle === "active" && current.version === requestVersion) {
          const revision = sessionRevision;
          const clients = state.clients;
          const params = queryParams();
          params.set("limit", "1");
          const page = await readJson<LogPage>(`./api/logs?${params}`, current.controller.signal);
          if (current.version !== requestVersion || lifecycle !== "active") return;
          if (state.serverId && page.serverId !== state.serverId) return;
          // Rule: 单路合并刷新；迟到索引不能覆盖期间的增量，稳定后再采用。
          if (revision !== sessionRevision) continue;
          state.sessions = page.sessions;
          sessionCursor = page.cursor;
          if (state.clients === clients) state.clients = page.clients;
          return;
        }
      } catch {
        if (current.version !== requestVersion || lifecycle !== "active" || current.controller.signal.aborted) return;
        notice("日志索引更新失败，请重新读取");
      }
    })().finally(() => { if (indexRead === current) indexRead = undefined; });
    return current.promise;
  }

  async function openDetail(id: number): Promise<void> {
    if (lifecycle !== "active") return;
    const generation = lifecycleVersion;
    state.selectedId = id;
    const selected = state.logs.find((log) => log.id === id);
    const requestId = selected && requestIdOf(selected);
    // Rule: 正文已在列表中，立即切换；网络只补全关联记录，不阻塞阅读。
    state.detail = selected
      ? {
          log: selected,
          related: requestId === undefined ? [] : state.logs.filter(
            (log) =>
              log.id !== id &&
              log.source === "http" &&
              log.clientKey === selected.clientKey &&
              log.sessionId === selected.sessionId &&
              requestIdOf(log) === requestId,
          ),
        }
      : undefined;
    try {
      const detail = await readJson<LogDetail>(`./api/logs/${id}`);
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

  function stopServicePolling(): void {
    clearTimeout(serviceTimer);
    serviceController?.abort();
    serviceController = undefined;
  }

  async function readService(): Promise<void> {
    if (lifecycle !== "active" || !serviceVisible) return;
    const controller = new AbortController();
    serviceController = controller;
    try {
      const service = await readJson<WorkbenchServiceStatus>("./api/status", controller.signal);
      if (controller.signal.aborted) return;
      state.service = service;
      state.serviceError = "";
    } catch (error) {
      if (controller.signal.aborted) return;
      state.serviceError = `读取服务状态失败：${error instanceof Error ? error.message : "网络错误"}`;
    } finally {
      if (!controller.signal.aborted) {
        serviceController = undefined;
        // Rule: 上一次读取结束后再排下一次，多页查看时错开读取缓存快照。
        serviceTimer = setTimeout(() => void readService(), RESOURCE_INTERVAL_MS + Math.random() * 1500);
      }
    }
  }

  function setServiceVisible(visible: boolean): void {
    if (serviceVisible === visible) return;
    serviceVisible = visible;
    if (visible) void readService();
    else stopServicePolling();
  }

  function connect(): void {
    if (lifecycle !== "active") return;
    clearTimeout(streamTimer);
    stream?.close();
    state.connection = "connecting";
    const openStream =
      options.openStream ??
      ((url: string) => new EventSource(url) as unknown as StreamLike);
    const query = streamQuery();
    const current = openStream(`./api/stream${query ? `?${query}` : ""}`);
    stream = current;
    const watch = (): void => {
      clearTimeout(streamTimer);
      // Rule: 服务端每 15 秒发送目录心跳；三个周期无事件则主动重建静默连接。
      streamTimer = setTimeout(() => {
        if (lifecycle !== "active" || stream !== current) return;
        notice("电脑实时连接超时，正在重新连接", true);
        connect();
      }, 45000);
    };
    watch();
    const listen = (type: string, listener: (event: Event) => void): void => {
      current.addEventListener(type, (event) => {
        if (lifecycle !== "active" || stream !== current) return;
        if (type !== "error" && type !== "open") {
          state.connection = "open";
          watch();
        }
        listener(event);
      });
    };
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
        const batch = JSON.parse((event as MessageEvent<string>).data) as {
          logs: StoredLog[];
          clients: LogClient[];
        } & Partial<ClientUpdate>;
        handleLogs(batch);
        if (batch.expiresBefore !== undefined && batch.evictedThroughId !== undefined)
          handleClients(batch as ClientUpdate);
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
    stopServicePolling();
    for (const controller of reads) controller.abort();
    state.loading = false;
    state.connection = "offline";
    state.streamReady = false;
    clearTimeout(streamTimer);
    clearTimeout(noticeTimer);
  }

  return {
    state,
    matches,
    load,
    loadOlder,
    loadLocal,
    latest,
    setFollowing,
    setPageVisible,
    setFilter,
    setScope,
    resetView,
    clearView,
    openDetail,
    closeDetail,
    setServiceVisible,
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
      void readService();
    },
    dispose(): void {
      if (lifecycle === "disposed") return;
      lifecycle = "disposed";
      stopIO();
    },
  };
}

export type Workbench = ReturnType<typeof createWorkbench>;
