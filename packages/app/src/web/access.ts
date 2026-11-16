// 访问密钥：构建时由 VITE_ACCESS_KEY 注入，默认值只用于本地演示。
// 门禁只阻止随手打开页面的人，不构成服务端安全边界。
const configuredAccessKey = (import.meta.env.VITE_ACCESS_KEY ?? "")
  .toUpperCase()
  .replace(/[^0-9A-Z]/g, "");
const DB_NAME = "h5-log-access";
const DB_VERSION = 1;
const STORE = "access";
const RECORD_KEY = "key";

/** 真实密钥放 .env.local 或 Compose 的 .env，不要提交到仓库。 */
export const ACCESS_KEY = configuredAccessKey || "2468";
export const ACCESS_KEY_LENGTH = ACCESS_KEY.length;

export function normalizeAccessKey(value: string): string {
  return value.trim().toUpperCase();
}

export function isAccessKey(value: string): boolean {
  return normalizeAccessKey(value) === normalizeAccessKey(ACCESS_KEY);
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined")
    return Promise.reject(new Error("浏览器不支持 IndexedDB"));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE))
        request.result.createObjectStore(STORE, { keyPath: "k" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("访问状态存储打开失败"));
    request.onblocked = () => reject(new Error("访问状态存储被其他页面占用"));
  });
}

async function useStore<T>(
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE, mode);
    const done = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("访问状态存储失败"));
      transaction.onabort = () => reject(transaction.error ?? new Error("访问状态存储已中止"));
    });
    try {
      const result = await new Promise<T>((resolve, reject) => {
        const request = action(transaction.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("访问状态存储失败"));
      });
      await done;
      return result;
    } catch (error) {
      await done.catch(() => undefined);
      throw error;
    }
  } finally {
    database.close();
  }
}

/** Failure: 浏览器不支持 IndexedDB 时返回 undefined，写入失败由调用方提示。 */
export async function readAccessKey(): Promise<string | undefined> {
  if (typeof indexedDB === "undefined") return undefined;
  const record = await useStore<{ v?: unknown } | undefined>(
    "readonly",
    (store) => store.get(RECORD_KEY),
  );
  return typeof record?.v === "string" ? record.v : undefined;
}

export async function saveAccessKey(value: string): Promise<void> {
  await useStore("readwrite", (store) =>
    store.put({ k: RECORD_KEY, v: normalizeAccessKey(value) }));
}

export async function clearAccessKey(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  await useStore("readwrite", (store) => store.delete(RECORD_KEY));
}
