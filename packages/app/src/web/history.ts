import type { StoredLog } from "@h5-log/sdk";

// 本地历史：旁路保存工作台看过的日志，不承担可靠投递。
const DB_NAME = "h5-log";
const DB_VERSION = 1;
const LOG_STORE = "logs";
const META_STORE = "meta";
const DETAIL_WIDTH_KEY = "ui:detail-width";
const ACCOUNTING_VERSION = 1;
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

interface Accounting {
  count: number;
  bytes: number;
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
    transaction.onerror = () => reject(transaction.error ?? new Error("本地存储事务失败"));
    transaction.onabort = () => reject(transaction.error ?? new Error("本地存储事务已中止"));
  });
}

async function transact<T>(
  database: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  action: (transaction: IDBTransaction) => Promise<T>,
): Promise<T> {
  const transaction = database.transaction(stores, mode);
  const done = finished(transaction);
  try {
    const result = await action(transaction);
    await done;
    return result;
  } catch (error) {
    // Failure: 已结束的事务不能再次中止，但原始失败仍向调用方传播。
    try { transaction.abort(); } catch { /* 事务已结束。 */ }
    await done.catch(() => undefined);
    throw error;
  }
}

/** Failure: 不支持 IndexedDB 时返回 undefined；运行期失败显式报告。 */
export function createLocalHistory(options: LocalHistoryOptions = {}): LocalHistory | undefined {
  if (typeof indexedDB === "undefined") return undefined;
  const maxLogs = options.maxLogs ?? DEFAULT_MAX_LOGS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let db: IDBDatabase | undefined;
  let opening: Promise<IDBDatabase> | undefined;
  let serverId = "";
  let generation = 0;
  let disposed = false;
  const pending = new Map<number, StoredLog>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ready: Promise<void> = Promise.resolve();
  let flushing: Promise<void> | undefined;
  let failureReported = false;

  const fail = (error: unknown): void => {
    if (disposed || failureReported) return;
    failureReported = true;
    options.onError?.(`本地历史不可用：${error instanceof Error ? error.message : "浏览器存储异常"}`);
  };

  function open(): Promise<IDBDatabase> {
    if (disposed) return Promise.reject(new Error("本地历史已关闭"));
    if (db) return Promise.resolve(db);
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      let blocked = false;
      req.onupgradeneeded = () => {
        const database = req.result;
        if (!database.objectStoreNames.contains(LOG_STORE))
          database.createObjectStore(LOG_STORE, { keyPath: ["serverId", "id"] });
        if (!database.objectStoreNames.contains(META_STORE))
          database.createObjectStore(META_STORE, { keyPath: "k" });
      };
      req.onsuccess = () => {
        const database = req.result;
        if (disposed || blocked) {
          database.close();
          reject(new Error(disposed ? "本地历史已关闭" : "本地存储被其他页面占用"));
          return;
        }
        database.onversionchange = () => {
          database.close();
          if (db === database) { db = undefined; opening = undefined; }
        };
        db = database;
        resolve(database);
      };
      req.onerror = () => reject(req.error ?? new Error("本地存储打开失败"));
      req.onblocked = () => { blocked = true; reject(new Error("本地存储被其他页面占用")); };
    }).catch((error: unknown) => {
      opening = undefined;
      fail(error);
      throw error;
    });
    return opening;
  }

  async function readMeta(store: IDBObjectStore) {
    const keys = ["serverId", "count", "bytes", "accountingVersion"];
    const rows = await Promise.all(keys.map((key) => request<{ v: unknown } | undefined>(store.get(key))));
    const [sid, count, bytes, version] = rows.map((row) => row?.v);
    const valid = typeof count === "number" && Number.isSafeInteger(count) && count >= 0 &&
      typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0;
    return {
      serverId: typeof sid === "string" ? sid : "",
      count: valid ? count : 0,
      bytes: valid ? bytes : 0,
      version: valid ? version : undefined,
    };
  }

  function writeMeta(store: IDBObjectStore, sid: string, accounting: Accounting): void {
    for (const [k, v] of Object.entries({ serverId: sid, count: accounting.count, bytes: accounting.bytes, accountingVersion: ACCOUNTING_VERSION }))
      store.put({ k, v });
  }

  function recount(store: IDBObjectStore, sid: string): Promise<Accounting> {
    const accounting = { count: 0, bytes: 0 };
    return new Promise((resolve, reject) => {
      const cursorRequest = store.openCursor();
      cursorRequest.onerror = () => reject(cursorRequest.error);
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) { resolve(accounting); return; }
        const record = cursor.value as StoredRecord;
        if (record.serverId !== sid) cursor.delete();
        else { accounting.count++; accounting.bytes += record.bytes; }
        cursor.continue();
      };
    });
  }

  function evict(store: IDBObjectStore, sid: string, accounting: Accounting): Promise<void> {
    if (accounting.count <= maxLogs && accounting.bytes <= maxBytes) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cursorRequest = store.openCursor(IDBKeyRange.bound(recordKey(sid, 0), recordKey(sid, Number.MAX_SAFE_INTEGER)));
      cursorRequest.onerror = () => reject(cursorRequest.error);
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor || (accounting.count <= maxLogs && accounting.bytes <= maxBytes)) { resolve(); return; }
        accounting.count--;
        accounting.bytes -= (cursor.value as StoredRecord).bytes;
        cursor.delete();
        cursor.continue();
      };
    });
  }

  async function writeBatch(database: IDBDatabase, sid: string, batch: StoredLog[], adopt = false): Promise<void> {
    await transact(database, [LOG_STORE, META_STORE], "readwrite", async (transaction) => {
      const store = transaction.objectStore(LOG_STORE);
      const metadata = transaction.objectStore(META_STORE);
      const meta = await readMeta(metadata);
      let accounting: Accounting = { count: meta.count, bytes: meta.bytes };
      if (meta.serverId !== sid) {
        // Rule: 只有实例切换可以清旧分区；另一页面的迟到写入不能切回旧实例。
        if (!adopt) return;
        store.clear();
        accounting = { count: 0, bytes: 0 };
      } else if (meta.version !== ACCOUNTING_VERSION) {
        // Rule: 旧计数只校准一次，不升级数据库版本，不清除有效日志或 UI 偏好。
        accounting = await recount(store, sid);
      }
      const previous = await Promise.all(batch.map((log) => request<StoredRecord | undefined>(store.get(recordKey(sid, log.id)))));
      for (let i = 0; i < batch.length; i++) {
        const base = { ...batch[i]!, serverId: sid };
        const bytes = byteSize(base);
        store.put({ ...base, bytes } satisfies StoredRecord);
        if (!previous[i]) accounting.count++;
        accounting.bytes += bytes - (previous[i]?.bytes ?? 0);
      }
      await evict(store, sid, accounting);
      // Guarantee: 跨页面计数、日志覆盖与淘汰共用一个读写事务。
      writeMeta(metadata, sid, accounting);
    });
  }

  function schedule(): void {
    if (disposed || flushing || pending.size === 0) return;
    if (pending.size >= FLUSH_BATCH) { void flush().catch(() => undefined); return; }
    timer ??= setTimeout(() => void flush().catch(() => undefined), FLUSH_DELAY_MS);
  }

  function flush(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    if (disposed) return Promise.resolve();
    if (flushing) return flushing.then(() => flush());
    if (pending.size === 0 || !serverId) return ready;
    const batch = [...pending.values()];
    pending.clear();
    const sid = serverId;
    const epoch = generation;
    const barrier = ready;
    flushing = (async () => {
      await barrier;
      if (disposed || epoch !== generation) return;
      const database = await open();
      if (disposed || epoch !== generation) return;
      await writeBatch(database, sid, batch);
    })().catch((error: unknown) => {
      fail(error);
      throw error;
    }).finally(() => {
      flushing = undefined;
      if (!disposed && pending.size > 0)
        timer ??= setTimeout(() => void flush().catch(() => undefined), FLUSH_DELAY_MS);
    });
    return flushing;
  }

  async function scan(database: IDBDatabase, sid: string, before: number | undefined, limit: number, accept: (log: StoredLog) => boolean): Promise<LocalHistoryPage> {
    const upper = before !== undefined ? before - 1 : Number.MAX_SAFE_INTEGER;
    if (upper < 0) return { logs: [], hasMore: false };
    return transact(database, [LOG_STORE, META_STORE], "readonly", async (transaction) => {
      const meta = await request<{ v: unknown } | undefined>(transaction.objectStore(META_STORE).get("serverId"));
      if (meta?.v !== sid) return { logs: [], hasMore: false };
      const found: StoredLog[] = [];
      let hasMore = false;
      await new Promise<void>((resolve, reject) => {
        const cursorRequest = transaction.objectStore(LOG_STORE).openCursor(IDBKeyRange.bound(recordKey(sid, 0), recordKey(sid, upper)), "prev");
        cursorRequest.onerror = () => reject(cursorRequest.error);
        cursorRequest.onsuccess = () => {
          try {
            const cursor = cursorRequest.result;
            if (!cursor) { resolve(); return; }
            const { serverId: _sid, bytes: _bytes, ...log } = cursor.value as StoredRecord;
            if (accept(log)) {
              if (found.length >= limit) { hasMore = true; resolve(); return; }
              found.push(log);
            }
            cursor.continue();
          } catch (error) { reject(error); }
        };
      });
      return { logs: found.reverse(), hasMore };
    });
  }

  async function page(options: { before?: number; limit: number; accept: (log: StoredLog) => boolean }): Promise<LocalHistoryPage> {
    const sid = serverId;
    const epoch = generation;
    await flush();
    if (!sid || disposed || epoch !== generation) return { logs: [], hasMore: false };
    return scan(await open(), sid, options.before, options.limit, options.accept);
  }

  return {
    setServerId(next): void {
      if (disposed || next === serverId) return;
      serverId = next;
      ++generation;
      pending.clear();
      clearTimeout(timer);
      timer = undefined;
      const adopt = async (): Promise<void> => {
        if (disposed || next !== serverId) return;
        const database = await open();
        if (!disposed && next === serverId) await writeBatch(database, next, [], true);
      };
      ready = ready.then(adopt, adopt);
      void ready.catch(fail);
    },
    append(logs): void {
      if (disposed || !serverId) return;
      for (const log of logs) pending.set(log.id, log);
      schedule();
    },
    page,
    async hasBefore(before, accept): Promise<boolean> {
      const result = await page({ before, limit: 1, accept });
      return result.logs.length > 0 || result.hasMore;
    },
    async clear(): Promise<void> {
      if (disposed) return;
      const epoch = ++generation;
      pending.clear();
      clearTimeout(timer);
      timer = undefined;
      const clear = async (): Promise<void> => {
        const database = await open();
        if (disposed || epoch !== generation) return;
        await transact(database, [LOG_STORE, META_STORE], "readwrite", async (transaction) => {
          const meta = transaction.objectStore(META_STORE);
          const current = await readMeta(meta);
          transaction.objectStore(LOG_STORE).clear();
          writeMeta(meta, current.serverId, { count: 0, bytes: 0 });
        });
      };
      ready = ready.then(clear, clear);
      return ready;
    },
    async loadDetailWidth(): Promise<number | undefined> {
      return transact(await open(), [META_STORE], "readonly", async (transaction) => {
        const record = await request<{ v: unknown } | undefined>(transaction.objectStore(META_STORE).get(DETAIL_WIDTH_KEY));
        if (record === undefined) return undefined;
        if (typeof record.v !== "number" || !Number.isFinite(record.v) || record.v <= 0)
          throw new Error("已保存的详情宽度无效");
        return record.v;
      });
    },
    async saveDetailWidth(width): Promise<void> {
      if (!Number.isFinite(width) || width <= 0) throw new Error("详情宽度无效");
      await transact(await open(), [META_STORE], "readwrite", async (transaction) => {
        await request(transaction.objectStore(META_STORE).put({ k: DETAIL_WIDTH_KEY, v: width }));
      });
    },
    dispose(): void {
      disposed = true;
      ++generation;
      pending.clear();
      clearTimeout(timer);
      timer = undefined;
      db?.close();
      db = undefined;
    },
  };
}
