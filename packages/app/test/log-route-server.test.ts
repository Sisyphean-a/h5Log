import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { createLogServer } from "../src/server/index.js";

it("筛选路径返回工作台并让资源和接口相对部署目录解析", async () => {
  const root = await mkdtemp(join(tmpdir(), "h5-log-route-"));
  await writeFile(join(root, "index.html"), '<html><head></head><body><script src="./assets/app.js"></script></body></html>');
  const app = createLogServer({ webRoot: root });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  try {
    for (const [path, base] of [["/console/埋点", "../"], ["/interface", "./"], ["/error/", "../"], ["/console/a/", "../../"]]) {
      const response = await fetch(origin + path);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(`<base href="${base}">`);
      expect(new URL(base!, `https://example.com/h5-log${path}`).pathname).toBe("/h5-log/");
    }
    expect((await fetch(origin + "/console/a/b")).status).toBe(404);
    expect((await fetch(origin + "/assets/missing.js")).status).toBe(404);
  } finally {
    app.closeStreams();
    app.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => app.server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
