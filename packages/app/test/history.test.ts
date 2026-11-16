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

  it("详情宽度跨实例保留，不影响日志，也不随日志清空或服务重启重置", async () => {
    const local = await start();
    expect(await local.loadDetailWidth()).toBeUndefined();
    local.append([log(1)]);
    await local.saveDetailWidth(640);
    expect((await local.page({ limit: 10, accept: acceptAll })).logs.map((item) => item.id)).toEqual([1]);
    await local.clear();
    local.setServerId("server-b");
    expect((await local.page({ limit: 10, accept: acceptAll })).logs).toEqual([]);
    expect(await local.loadDetailWidth()).toBe(640);
    local.dispose();
    history = createLocalHistory()!;
    expect(await history.loadDetailWidth()).toBe(640);
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
