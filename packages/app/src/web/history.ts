import type { StoredLog } from "@h5-log/sdk";

// 本地历史：把工作台看过的日志存在浏览器 IndexedDB，服务端保留窗口之外的记录仍可回看。
// Rule: 写入后台批量进行，不阻塞实时渲染；容量按条数与字节双上限淘汰最旧记录。
const DB_NAME = "h5-log";
const DB_VERSION = 1;
const LOG_STORE = "logs";
const META_STORE = "meta";
const DETAIL_WIDTH_KEY = "ui:detail-width";
const DEFAULT_MAX_LOGS = 50_000;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const FLUSH_DELAY_MS = 150;
const FLUSH_BATCH = 200;

export interface LocalHistoryPage {
  logs: StoredLog[];
  hasMore: boolean;
}

export interface LocalHistory {
  setServerId(serverId: string): void;
  append(logs: StoredLog[]): void;
  page(options: {
    before?: number;
    limit: number;
    accept: (log: StoredLog) => boolean;
  }): Promise<LocalHistoryPage>;
  hasBefore(before: number, accept: (log: StoredLog) => boolean): Promise<boolean>;
  clear(): Promise<void>;
  loadDetailWidth(): Promise<number | undefined>;
  saveDetailWidth(width: number): Promise<void>;
  dispose(): void;
}

interface StoredRecord extends StoredLog {
  serverId: string;
  bytes: number;
}

export interface LocalHistoryOptions {
  maxLogs?: number;
  maxBytes?: number;
  onError?: (message: string) => void;
}

const encoder = new TextEncoder();

function recordKey(serverId: string, id: number): [string, number] {
  return [serverId, id];
}

function byteSize(record: Omit<StoredRecord, "bytes">): number {
  return encoder.encode(JSON.stringify(record)).byteLength;
}

function request<T>(source: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    source.onsuccess = () => resolve(source.result);
    source.onerror = () => reject(source.error ?? new Error("本地存储请求失败"));
  });
}

function finished(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("本地存储事务失败"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("本地存储事务已中止"));
  });
}

/** Failure: 浏览器禁用存储或配额不足时返回 undefined，工作台退回纯服务端窗口。 */
export function createLocalHistory(
  options: LocalHistoryOptions = {},
): LocalHistory | undefined {
  if (typeof indexedDB === "undefined") return undefined;
  const maxLogs = options.maxLogs ?? DEFAULT_MAX_LOGS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let db: IDBDatabase | undefined;
  let opening: Promise<IDBDatabase> | undefined;
  let serverId = "";
  let totalCount = 0;
  let totalBytes = 0;
  let pending: StoredLog[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ready: Promise<void> = Promise.resolve();
  let failureReported = false;

  const fail = (error: unknown): void => {
    if (failureReported) return;
    failureReported = true;
    options.onError?.(
      `本地历史不可用：${error instanceof Error ? error.message : "浏览器存储异常"}`,
    );
  };

  function open(): Promise<IDBDatabase> {
    if (db) return Promise.resolve(db);
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const database = req.result;
        if (!database.objectStoreNames.contains(LOG_STORE))
          database.createObjectStore(LOG_STORE, {
            keyPath: ["serverId", "id"],
          });
        if (!database.objectStoreNames.contains(META_STORE))
          database.createObjectStore(META_STORE, { keyPath: "k" });
      };
      req.onsuccess = () => {
        const database = req.result;
        database.onversionchange = () => database.close();
        db = database;
        resolve(database);
      };
      req.onerror = () => reject(req.error ?? new Error("本地存储打开失败"));
      req.onblocked = () => reject(new Error("本地存储被其他页面占用"));
    }).catch((error: unknown) => {
      opening = undefined;
      fail(error);
      throw error;
    });
    return opening;
  }

  async function readMeta(database: IDBDatabase): Promise<{
    serverId: string;
    count: number;
    bytes: number;
  }> {
    const transaction = database.transaction(META_STORE, "readonly");
    const store = transaction.objectStore(META_STORE);
    const [sid, count, bytes] = await Promise.all([
      request(store.get("serverId")),
      request(store.get("count")),
      request(store.get("bytes")),
    ]);
    await finished(transaction).catch(() => undefined);
    const read = (value: unknown): number =>
      typeof value === "object" && value !== null && "v" in value
        ? Number((value as { v: unknown }).v) || 0
        : 0;
    return {
      serverId:
        typeof sid === "object" && sid !== null && "v" in sid
          ? String((sid as { v: unknown }).v)
          : "",
      count: read(count),
      bytes: read(bytes),
    };
  }

  async function writeMeta(
    database: IDBDatabase,
    entries: Record<string, number | string>,
  ): Promise<void> {
    const transaction = database.transaction(META_STORE, "readwrite");
    const store = transaction.objectStore(META_STORE);
    for (const [key, value] of Object.entries(entries))
      store.put({ k: key, v: value });
    await finished(transaction).catch(() => undefined);
  }

  async function adoptServerId(database: IDBDatabase, next: string): Promise<void> {
    const meta = await readMeta(database);
    if (meta.serverId === next) {
      totalCount = meta.count;
      totalBytes = meta.bytes;
      return;
    }
    const transaction = database.transaction(LOG_STORE, "readwrite");
    transaction.objectStore(LOG_STORE).clear();
    await finished(transaction).catch(() => undefined);
    totalCount = 0;
    totalBytes = 0;
    await writeMeta(database, { serverId: next, count: 0, bytes: 0 });
  }

  async function evict(database: IDBDatabase): Promise<void> {
    if (totalCount <= maxLogs && totalBytes <= maxBytes) return;
    const transaction = database.transaction(LOG_STORE, "readwrite");
    const store = transaction.objectStore(LOG_STORE);
    const cursorRequest = store.openCursor(
      IDBKeyRange.bound([serverId, 0], [serverId, Number.MAX_SAFE_INTEGER]),
    );
    let removed = 0;
    let removedBytes = 0;
    await new Promise<void>((resolve) => {
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (
          !cursor ||
          (totalCount - removed <= maxLogs && totalBytes - removedBytes <= maxBytes)
        ) {
          resolve();
          return;
        }
        const record = cursor.value as StoredRecord;
        removed++;
        removedBytes += record.bytes;
        cursor.delete();
        cursor.continue();
      };
      cursorRequest.onerror = () => resolve();
    });
    await finished(transaction).catch(() => undefined);
    totalCount -= removed;
    totalBytes -= removedBytes;
    await writeMeta(database, { count: totalCount, bytes: totalBytes });
  }

  async function flush(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    if (pending.length === 0 || !serverId) return;
    await ready;
    const batch = pending;
    pending = [];
    try {
      const database = await open();
      const transaction = database.transaction(LOG_STORE, "readwrite");
      const store = transaction.objectStore(LOG_STORE);
      let added = 0;
      let addedBytes = 0;
      for (const log of batch) {
        const base = { ...log, serverId };
        const bytes = byteSize(base);
        store.put({ ...base, bytes } satisfies StoredRecord);
        added++;
        addedBytes += bytes;
      }
      await finished(transaction);
      totalCount += added;
      totalBytes += addedBytes;
      await writeMeta(database, { count: totalCount, bytes: totalBytes });
      await evict(database);
    } catch (error) {
      fail(error);
    }
  }

  function schedule(): void {
    if (pending.length >= FLUSH_BATCH) {
      void flush();
      return;
    }
    timer ??= setTimeout(() => void flush(), FLUSH_DELAY_MS);
  }

  async function scan(
    database: IDBDatabase,
    before: number | undefined,
    limit: number,
    accept: (log: StoredLog) => boolean,
  ): Promise<LocalHistoryPage> {
    const upper = before !== undefined ? before - 1 : Number.MAX_SAFE_INTEGER;
    if (upper < 0) return { logs: [], hasMore: false };
    const transaction = database.transaction(LOG_STORE, "readonly");
    const store = transaction.objectStore(LOG_STORE);
    const found: StoredLog[] = [];
    let hasMore = false;
    await new Promise<void>((resolve) => {
      const request_ = store.openCursor(
        IDBKeyRange.bound([serverId, 0], [serverId, upper]),
        "prev",
      );
      request_.onsuccess = () => {
        const cursor = request_.result;
        if (!cursor) {
          resolve();
          return;
        }
        const { serverId: _sid, bytes: _bytes, ...log } =
          cursor.value as StoredRecord;
        if (accept(log)) {
          if (found.length >= limit) {
            hasMore = true;
            resolve();
            return;
          }
          found.push(log);
        }
        cursor.continue();
      };
      request_.onerror = () => resolve();
    });
    await finished(transaction).catch(() => undefined);
    return { logs: found.reverse(), hasMore };
  }

  return {
    setServerId(next: string): void {
      if (next === serverId) return;
      serverId = next;
      // Rule: 先完成分区切换再写日志，避免重启后 id 从 1 开始时新旧记录混在一起。
      ready = ready
        .then(() => open())
        .then((database) => adoptServerId(database, next))
        .catch((error: unknown) => fail(error));
    },
    append(logs: StoredLog[]): void {
      if (logs.length === 0 || !serverId) return;
      pending.push(...logs);
      schedule();
    },
    async page({ before, limit, accept }): Promise<LocalHistoryPage> {
      await flush();
      if (!serverId) return { logs: [], hasMore: false };
      return scan(await open(), before, limit, accept);
    },
    async hasBefore(before, accept): Promise<boolean> {
      await flush();
      if (!serverId) return false;
      const page = await scan(await open(), before, 1, accept);
      return page.logs.length > 0 || page.hasMore;
    },
    async clear(): Promise<void> {
      await ready;
      pending = [];
      clearTimeout(timer);
      timer = undefined;
      const database = await open();
      const transaction = database.transaction(LOG_STORE, "readwrite");
      transaction.objectStore(LOG_STORE).clear();
      await finished(transaction).catch(() => undefined);
      totalCount = 0;
      totalBytes = 0;
      await writeMeta(database, { count: 0, bytes: 0 });
    },
    async loadDetailWidth(): Promise<number | undefined> {
      const database = await open();
      const transaction = database.transaction(META_STORE, "readonly");
      const [record] = await Promise.all([
        request<{ k: string; v: unknown } | undefined>(transaction.objectStore(META_STORE).get(DETAIL_WIDTH_KEY)),
        finished(transaction),
      ]);
      if (record === undefined) return undefined;
      if (typeof record.v !== "number" || !Number.isFinite(record.v) || record.v <= 0)
        throw new Error("已保存的详情宽度无效");
      return record.v;
    },
    async saveDetailWidth(width: number): Promise<void> {
      if (!Number.isFinite(width) || width <= 0) throw new Error("详情宽度无效");
      const database = await open();
      const transaction = database.transaction(META_STORE, "readwrite");
      await Promise.all([
        request(transaction.objectStore(META_STORE).put({ k: DETAIL_WIDTH_KEY, v: width })),
        finished(transaction),
      ]);
    },
    dispose(): void {
      clearTimeout(timer);
      timer = undefined;
      db?.close();
      db = undefined;
      opening = undefined;
    },
  };
}
