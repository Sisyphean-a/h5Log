import type {
  LogClient,
  LogDetail,
  LogEvent,
  LogPage,
  LogSession,
  StoredLog,
} from "@h5-log/sdk";
import { randomUUID } from "node:crypto";
import { createLogMatcher, type LogFilter as EventFilter } from "../log-filter.js";

export const RETENTION_HOURS = 12;
export interface StoreOptions {
  maxLogs?: number;
  maxBytes?: number;
  retentionHours?: number;
  now?: () => number;
}
export interface LogFilter extends EventFilter {
  before?: number;
  after?: number;
  limit?: number;
}
interface Entry {
  log: StoredLog;
  bytes: number;
  dedupeKey: string;
}

export class LogStore {
  readonly serverId = randomUUID();
  readonly retentionHours: number;
  private readonly retentionMs: number;
  private readonly entries: (Entry | undefined)[] = [];
  private readonly eventKeys = new Set<string>();
  private readonly clientMap = new Map<string, LogClient>();
  private readonly maxLogs: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private head = 0;
  private sequence = 0;
  private bytes = 0;
  private received = 0;
  private evicted = 0;
  private evictedThroughId = 0;

  constructor(options: StoreOptions = {}) {
    this.maxLogs = options.maxLogs ?? 8000;
    this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
    this.retentionHours = options.retentionHours ?? RETENTION_HOURS;
    this.retentionMs = this.retentionHours * 60 * 60 * 1000;
    this.now = options.now ?? Date.now;
    for (const [key, value] of Object.entries({
      maxLogs: this.maxLogs,
      maxBytes: this.maxBytes,
      retentionHours: this.retentionHours,
    })) {
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error(`${key} 必须为正整数`);
    }
  }

  add(events: LogEvent[]): StoredLog[] {
    this.prune();
    const accepted: Entry[] = [];
    const receivedAt = this.now();
    for (const event of events) {
      const clientKey = JSON.stringify([
        event.appId,
        event.environment,
        event.deviceId,
      ]);
      const dedupeKey = JSON.stringify([
        clientKey,
        event.sessionId,
        event.eventId,
      ]);
      if (this.eventKeys.has(dedupeKey)) continue;
      const log: StoredLog = {
        ...event,
        id: ++this.sequence,
        receivedAt,
        clientKey,
      };
      const bytes = Buffer.byteLength(JSON.stringify(log));
      const entry = { log, bytes, dedupeKey };
      this.entries.push(entry);
      accepted.push(entry);
      this.received++;
      this.bytes += bytes;
      this.eventKeys.add(dedupeKey);
      const previous = this.clientMap.get(clientKey);
      this.clientMap.set(clientKey, {
        key: clientKey,
        appId: event.appId,
        environment: event.environment,
        deviceId: event.deviceId,
        sessionId: event.sessionId,
        deviceName: event.deviceName,
        userAgent: event.userAgent,
        lastSeen: receivedAt,
        logCount: (previous?.logCount ?? 0) + 1,
        errorCount:
          (previous?.errorCount ?? 0) + (event.level === "error" ? 1 : 0),
      });
    }
    this.prune();
    return accepted
      .filter((entry) => this.eventKeys.has(entry.dedupeKey))
      .map((entry) => entry.log);
  }

  expiryCutoff(): number {
    return this.now() - this.retentionMs;
  }

  prune(): void {
    const cutoff = this.expiryCutoff();
    while (this.head < this.entries.length) {
      const entry = this.entries[this.head];
      if (!entry) throw new Error("日志索引已损坏");
      if (
        entry.log.receivedAt > cutoff &&
        this.entries.length - this.head <= this.maxLogs &&
        this.bytes <= this.maxBytes
      )
        break;
      this.bytes -= entry.bytes;
      this.eventKeys.delete(entry.dedupeKey);
      const client = this.clientMap.get(entry.log.clientKey);
      if (client) {
        client.logCount--;
        if (entry.log.level === "error") client.errorCount--;
        if (client.logCount <= 0) this.clientMap.delete(entry.log.clientKey);
      }
      this.entries[this.head] = undefined;
      this.head++;
      this.evicted++;
      this.evictedThroughId = entry.log.id;
    }
    // Rule: 淘汰按游标推进，分段压缩避免每批上传都移动整个日志数组。
    if (this.head > 1024 || this.head === this.entries.length) {
      this.entries.splice(0, this.head);
      this.head = 0;
    }
  }

  clients(): LogClient[] {
    this.prune();
    const models = new Map<string, Map<string, number>>();
    // Rule: 按设备首次出现顺序编号，同一设备跨应用复用编号，不随最近上报排序变化。
    for (const client of this.clientMap.values()) {
      if (!client.deviceName) continue;
      let devices = models.get(client.deviceName);
      if (!devices) {
        devices = new Map();
        models.set(client.deviceName, devices);
      }
      if (!devices.has(client.deviceId))
        devices.set(client.deviceId, devices.size + 1);
    }
    return [...this.clientMap.values()]
      .map((client) => {
        const devices = models.get(client.deviceName);
        return devices && devices.size > 1
          ? { ...client, deviceName: `${client.deviceName}-${devices.get(client.deviceId)}` }
          : client;
      })
      .sort((a, b) => b.lastSeen - a.lastSeen);
  }

  page(filter: LogFilter = {}): LogPage {
    this.prune();
    const limit = Math.min(200, Math.max(1, filter.limit ?? 200));
    const matcher = createLogMatcher(filter);
    const found: StoredLog[] = [];
    const sessions = new Map<string, LogSession>();
    let total = 0;
    for (let i = this.entries.length - 1; i >= this.head; i--) {
      const entry = this.entries[i];
      if (!entry) continue;
      const log = entry.log;
      if (!matcher.inScope(log)) continue;
      // Rule: 会话列表属于客户端范围，不被当前级别、关键词和分页截断。
      const key = JSON.stringify([log.clientKey, log.sessionId]);
      const session = sessions.get(key);
      if (session) {
        session.firstSeen = log.receivedAt;
        session.logCount++;
        if (log.level === "error") session.errorCount++;
      } else
        sessions.set(key, {
          clientKey: log.clientKey,
          sessionId: log.sessionId,
          firstSeen: log.receivedAt,
          lastSeen: log.receivedAt,
          logCount: 1,
          errorCount: log.level === "error" ? 1 : 0,
          pageUrl: log.pageUrl,
        });
      if (filter.after !== undefined && log.id <= filter.after) continue;
      if (!matcher.matches(log)) continue;
      total++;
      if (filter.before !== undefined && log.id >= filter.before) continue;
      if (found.length <= limit) found.push(log);
    }
    return {
      logs: found.slice(0, limit).reverse(),
      clients: this.clients(),
      sessions: [...sessions.values()],
      total,
      cursor: this.sequence,
      hasMore: found.length > limit,
      retentionHours: this.retentionHours,
      serverId: this.serverId,
    };
  }

  detail(id: number): LogDetail | undefined {
    this.prune();
    let log: StoredLog | undefined;
    for (let i = this.head; i < this.entries.length; i++) {
      const entry = this.entries[i];
      if (entry?.log.id === id) {
        log = entry.log;
        break;
      }
    }
    if (!log) return undefined;
    const payload = log.args[0];
    const requestId =
      log.requestId ??
      (log.source === "http" &&
      payload &&
      typeof payload === "object" &&
      !Array.isArray(payload)
        ? payload.requestId
        : undefined);
    const related: StoredLog[] = [];
    if (typeof requestId === "string") {
      for (let i = this.head; i < this.entries.length; i++) {
        const item = this.entries[i]?.log;
        if (!item) continue;
        if (
          item.id === log.id ||
          item.source !== "http" ||
          item.clientKey !== log.clientKey ||
          item.sessionId !== log.sessionId
        )
          continue;
        const data = item.args[0];
        const itemRequestId =
          item.requestId ??
          (data && typeof data === "object" && !Array.isArray(data)
            ? data.requestId
            : undefined);
        if (itemRequestId === requestId) related.push(item);
      }
    }
    return { log, related };
  }

  stats() {
    this.prune();
    const sessions = new Set<string>();
    for (let i = this.head; i < this.entries.length; i++) {
      const log = this.entries[i]?.log;
      if (log) sessions.add(JSON.stringify([log.clientKey, log.sessionId]));
    }
    return {
      logs: this.entries.length - this.head,
      bytes: this.bytes,
      clients: this.clientMap.size,
      sessions: sessions.size,
      received: this.received,
      evicted: this.evicted,
      evictedThroughId: this.evictedThroughId,
      limits: { maxLogs: this.maxLogs, maxBytes: this.maxBytes },
    };
  }
}
