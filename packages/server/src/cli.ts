import { fileURLToPath } from "node:url";
import { createLogServer, LogStore } from "./index.js";

function positiveNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${name} 必须是正整数`);
  return parsed;
}

const port = positiveNumber("PORT", 3000);
if (port > 65535) throw new Error("PORT 超出端口范围");
const host = process.env.HOST ?? "127.0.0.1";
const { server, close } = createLogServer({
  webRoot: fileURLToPath(new URL("../../web/dist/", import.meta.url)),
  store: new LogStore({
    maxLogs: positiveNumber("MAX_LOGS", 20000),
    maxBytes: positiveNumber("MAX_MEMORY_MB", 32) * 1024 * 1024,
  }),
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "*")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
});
server.on("error", (error) => {
  console.error("[h5-log]", error);
  process.exitCode = 1;
});
server.listen(port, host, () => console.info(`H5 Log: http://${host}:${port}`));
let stopping = false;
function stop(): void {
  if (stopping) return;
  stopping = true;
  if (!server.listening) {
    process.exit(0);
    return;
  }
  void close().then(
    () => process.exit(0),
    (error) => {
      console.error("[h5-log] 关闭失败", error);
      process.exit(1);
    },
  );
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
