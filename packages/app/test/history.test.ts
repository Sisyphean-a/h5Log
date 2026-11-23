import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StoredLog } from "@h5-log/sdk";
import { createLocalHistory, type LocalHistory } from "../src/web/history.js";

let history: LocalHistory | undefined;

function log(id: number, extra: Partial<StoredLog> = {}): StoredLog {
  return {
    id,
    appId: "26",
    environment: "test",
    deviceId: "phone-a",
    sessionId: "session-a",
    deviceName: "测试手机",
    userAgent: "WebView",
    pageUrl: "https://h5.test/home",
    timestamp: 1700000000000 + id,
    level: "info",
    source: "console",
    args: [`entry-${id}`],
    receivedAt: 1700000000000 + id,
    clientKey: '["26","test","phone-a"]',
    eventId: `evt-${id}`,
    ...extra,
  };
}

const acceptAll = () => true;

async function start(options = {}): Promise<LocalHistory> {
  history = createLocalHistory(options);
  if (!history) throw new Error("本地历史不可用");
  history.setServerId("server-a");
  return history;
}

beforeEach(() => {
  indexedDB.deleteDatabase("h5-log");
});
afterEach(() => {
  vi.restoreAllMocks();
  history?.dispose();
  history = undefined;
});

describe("浏览器本地历史", () => {
  it.each(["count", "bytes"] as const)("重复日志不重复计算 %s，也不提前淘汰历史", async (limit) => {
    const bytes = new TextEncoder().encode(JSON.stringify({ ...log(1), serverId: "server-a" })).length;
    const local = await start(limit === "count" ? { maxLogs: 3 } : { maxLogs: 100, maxBytes: bytes * 3 });
    const entries = [log(1), log(2), log(3)];
    local.append(entries);
    await local.page({ limit: 10, accept: acceptAll });
    local.append(entries);
    expect((await local.page({ limit: 10, accept: acceptAll })).logs.map((item) => item.id)).toEqual([1, 2, 3]);
  });

  it("多个页面交错及并发写入仍按共享容量淘汰", async () => {
    const first = await start({ maxLogs: 3 });
    first.append([log(1)]);
    await first.page({ limit: 10, accept: acceptAll });
    const second = createLocalHistory({ maxLogs: 3 })!;
    try {
      second.setServerId("server-a");
      second.append([log(2)]);
      await second.page({ limit: 10, accept: acceptAll });
      first.append([log(3), log(4)]);
      expect((await first.page({ limit: 10, accept: acceptAll })).logs.map((item) => item.id)).toEqual([2, 3, 4]);
      first.append([log(5)]);
      second.append([log(6)]);
      await Promise.all([first.page({ limit: 10, accept: acceptAll }), second.page({ limit: 10, accept: acceptAll })]);
      expect((await first.page({ limit: 10, accept: acceptAll })).logs.map((item) => item.id)).toEqual([4, 5, 6]);
    } finally {
      second.dispose();
    }
  });

  it("服务切换丢弃未落盘旧批次，不把旧记录标成新实例", async () => {
    const local = await start();
    local.append([log(10)]);
    local.setServerId("server-b");
    local.append([log(1)]);
    expect((await local.page({ limit: 10, accept: acceptAll })).logs.map((item) => item.id)).toEqual([1]);
  });

  it("旧批次写入途中切换实例，最终仅保留新实例记录", async () => {
    const local = await start();
    const put = IDBObjectStore.prototype.put;
    let switched = false;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
      if (!switched && value?.id === 10) {
        switched = true;
        local.setServerId("server-b");
        local.append([log(1)]);
      }
      return put.call(this, value, key);
    });
    local.append([log(10), log(11)]);
    await local.page({ limit: 10, accept: acceptAll });
    expect(switched).toBe(true);
    expect((await local.page({ limit: 10, accept: acceptAll })).logs.map((item) => item.id)).toEqual([1]);
  });

  it("另一个页面切换实例后，旧页面不能再写回旧分区", async () => {
    const first = await start();
    first.append([log(1)]);
    await first.page({ limit: 10, accept: acceptAll });
    const second = createLocalHistory()!;
    try {
      second.setServerId("server-b");
      second.append([log(2)]);
      await second.page({ limit: 10, accept: acceptAll });
      first.append([log(10)]);
      expect((await first.page({ limit: 10, accept: acceptAll })).logs).toEqual([]);
      expect((await second.page({ limit: 10, accept: acceptAll })).logs.map((item) => item.id)).toEqual([2]);
    } finally {
      second.dispose();
    }
  });

  it("旧版本错误计数在原库内校准，不删除有效日志或详情宽度", async () => {
    const local = await start({ maxLogs: 3 });
    await local.saveDetailWidth(640);
    local.append([log(1), log(2), log(3)]);
    await local.page({ limit: 10, accept: acceptAll });
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open("h5-log", 1);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      const tx = database.transaction("meta", "readwrite");
      const meta = tx.objectStore("meta");
      meta.put({ k: "count", v: 300 });
      meta.put({ k: "bytes", v: 1024 * 1024 });
      meta.delete("accountingVersion");
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    } finally {
      database.close();
    }
    local.dispose();
    const reopened = await start({ maxLogs: 3 });
    reopened.append([log(3)]);
    expect((await reopened.page({ limit: 10, accept: acceptAll })).logs.map((item) => item.id)).toEqual([1, 2, 3]);
    expect(await reopened.loadDetailWidth()).toBe(640);
  });

  it("日志事务失败明确拒绝且不留下计数半提交，后续写入可恢复", async () => {
    const local = await start({ maxLogs: 3 });
    local.append([log(1), log(2)]);
    await local.page({ limit: 10, accept: acceptAll });
    const put = IDBObjectStore.prototype.put;
    const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (this: IDBObjectStore, value, key) {
      const result = put.call(this, value, key);
      if (value?.id === 3) this.transaction.abort();
      return result;
    });
    local.append([log(3)]);
    await expect(local.page({ limit: 10, accept: acceptAll })).rejects.toThrow();
    spy.mockRestore();
    local.append([log(4)]);
    expect((await local.page({ limit: 10, accept: acceptAll })).logs.map((item) => item.id)).toEqual([1, 2, 4]);
  });
  it("按 id 从新到旧分页，返回时恢复为旧在前", async () => {
    const local = await start();
    local.append([log(1), log(2), log(3), log(4), log(5)]);
    const first = await local.page({ limit: 2, accept: acceptAll });
    expect(first.logs.map((item) => item.id)).toEqual([4, 5]);
    expect(first.hasMore).toBe(true);
    const second = await local.page({
      before: 4,
      limit: 2,
      accept: acceptAll,
    });
    expect(second.logs.map((item) => item.id)).toEqual([2, 3]);
    expect(second.hasMore).toBe(true);
    const last = await local.page({ before: 2, limit: 2, accept: acceptAll });
    expect(last.logs.map((item) => item.id)).toEqual([1]);
    expect(last.hasMore).toBe(false);
  });

  it("筛选谓词在存储层之上生效，并按命中条数判断还有更早记录", async () => {
    const local = await start();
    local.append([
      log(1, { level: "error" }),
      log(2),
      log(3, { level: "error" }),
      log(4),
    ]);
    const errors = await local.page({
      before: 4,
      limit: 1,
      accept: (item) => item.level === "error",
    });
    expect(errors.logs.map((item) => item.id)).toEqual([3]);
    expect(errors.hasMore).toBe(true);
    expect(await local.hasBefore(1, () => true)).toBe(false);
    expect(await local.hasBefore(4, () => true)).toBe(true);
  });

  it("超出条数上限时淘汰最旧记录", async () => {
    const local = await start({ maxLogs: 3 });
    for (let id = 1; id <= 10; id++) {
      local.append([log(id)]);
      await local.page({ limit: 1, accept: acceptAll });
    }
    const page = await local.page({ limit: 10, accept: acceptAll });
    expect(page.logs.map((item) => item.id)).toEqual([8, 9, 10]);
  });

  it("服务端重启（serverId 变化）后清空旧分区", async () => {
    const local = await start();
    local.append([log(1), log(2)]);
    await local.page({ limit: 1, accept: acceptAll });
    const restarted = createLocalHistory()!;
    history?.dispose();
    history = restarted;
    restarted.setServerId("server-b");
    restarted.append([log(9)]);
    const page = await restarted.page({ limit: 10, accept: acceptAll });
    expect(page.logs.map((item) => item.id)).toEqual([9]);
  });

  it("详情宽度与 URL 解析偏好不随日志清空或服务重启重置", async () => {
    const local = await start();
    expect(await local.loadDetailWidth()).toBeUndefined();
    expect(await local.loadPageUrlParsing()).toBeUndefined();
    local.append([log(1)]);
    await local.saveDetailWidth(640);
    await local.savePageUrlParsing(true);
    expect((await local.page({ limit: 10, accept: acceptAll })).logs.map((item) => item.id)).toEqual([1]);
    await local.clear();
    local.setServerId("server-b");
    expect((await local.page({ limit: 10, accept: acceptAll })).logs).toEqual([]);
    expect(await local.loadDetailWidth()).toBe(640);
    local.dispose();
    history = createLocalHistory()!;
    expect(await history.loadDetailWidth()).toBe(640);
    expect(await history.loadPageUrlParsing()).toBe(true);
    await expect(history.saveDetailWidth(Number.NaN)).rejects.toThrow("详情宽度无效");
    expect(await history.loadDetailWidth()).toBe(640);
  });

  it("详情宽度写入被中止时明确拒绝，不假装保存成功", async () => {
    const local = await start();
    await local.page({ limit: 1, accept: acceptAll });
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(function (this: IDBObjectStore, value, key) {
      const result = put.call(this, value, key);
      this.transaction.abort();
      return result;
    });
    await expect(local.saveDetailWidth(640)).rejects.toThrow();
    expect(await local.loadDetailWidth()).toBeUndefined();
  });

  it("浏览器不支持 IndexedDB 时返回 undefined，工作台退回服务端窗口", () => {
    const native = globalThis.indexedDB;
    // @ts-expect-error 模拟不支持存储的环境
    delete globalThis.indexedDB;
    expect(createLocalHistory()).toBeUndefined();
    globalThis.indexedDB = native;
  });
});
