import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACCESS_KEY,
  clearAccessKey,
  isAccessKey,
  normalizeAccessKey,
  readAccessKey,
  saveAccessKey,
} from "../src/web/access.js";

beforeEach(async () => {
  await clearAccessKey();
});

describe("访问密钥", () => {
  it("接受 4 位数字或字母，忽略大小写和首尾空白", () => {
    expect(isAccessKey(` ${ACCESS_KEY.toLowerCase()} `)).toBe(true);
    expect(isAccessKey("0000")).toBe(false);
    expect(normalizeAccessKey(" ab12 ")).toBe("AB12");
  });

  it("把解锁状态写入 IndexedDB，读回后再次打开无需登录", async () => {
    expect(await readAccessKey()).toBeUndefined();
    await saveAccessKey(ACCESS_KEY);
    expect(await readAccessKey()).toBe(ACCESS_KEY);
  });

  it("清除浏览器数据后回到未登录状态", async () => {
    await saveAccessKey(ACCESS_KEY);
    await clearAccessKey();
    expect(await readAccessKey()).toBeUndefined();
  });

  it("构建时环境变量覆盖默认密钥", async () => {
    vi.stubEnv("VITE_ACCESS_KEY", "ab12");
    vi.resetModules();
    const configured = await import("../src/web/access.js");
    expect(configured.ACCESS_KEY).toBe("AB12");
    expect(configured.isAccessKey("ab12")).toBe(true);
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
