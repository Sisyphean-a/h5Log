import "./base.css";
import "./demo.css";
import axios from "axios";
import { createLogger } from "@h5-log/sdk";
import { attachAxiosLogger } from "@h5-log/sdk/axios";

const logger = createLogger({
  enabled: true,
  appId: "demo-h5",
  environment: "test",
  deviceName: "浏览器演示",
  endpoint: "/api/logs",
});
const client = axios.create();
const detach = attachAxiosLogger(client, logger);
const message = document.getElementById("demo-message") as HTMLInputElement;
const result = document.getElementById("demo-result")!;
document.getElementById("demo-client")!.textContent =
  `客户端 ${logger.context.deviceId.slice(0, 8)} · 会话 ${logger.context.sessionId.slice(0, 8)}`;
document
  .getElementById("demo-log")!
  .addEventListener("click", () =>
    console.log(message.value, { app: "demo-h5", action: "test" }),
  );
document
  .getElementById("demo-warn")!
  .addEventListener("click", () => console.warn(message.value));
document.getElementById("demo-error")!.addEventListener("click", () => {
  window.dispatchEvent(
    new ErrorEvent("error", {
      error: new Error(message.value),
      message: message.value,
    }),
  );
});
document.getElementById("demo-object")!.addEventListener("click", () => {
  const object: Record<string, unknown> = {
    message: message.value,
    items: [1, 2, 3],
  };
  object.self = object;
  console.info("对象快照", object);
});
async function request(fail: boolean): Promise<void> {
  result.textContent = "请求中…";
  try {
    const response = await client.get(fail ? "/api/not-found" : "/api/health", {
      params: { from: "sdk-demo", message: message.value },
    });
    result.textContent = JSON.stringify(response.data, null, 2);
  } catch (error) {
    result.textContent = error instanceof Error ? error.message : String(error);
  }
}
document.getElementById("demo-request")!.addEventListener("click", () => {
  void request(false);
});
document
  .getElementById("demo-failed-request")!
  .addEventListener("click", () => {
    void request(true);
  });
const timer = setInterval(() => {
  const status = logger.getStatus();
  document.getElementById("demo-status")!.textContent =
    status.lastError ?? `待发送 ${status.queued} · 已丢弃 ${status.dropped}`;
}, 1000);
window.addEventListener("pagehide", (event) => {
  if (!event.persisted) {
    detach();
    clearInterval(timer);
  }
});
console.info("SDK 已接入", {
  appId: logger.context.appId,
  sessionId: logger.context.sessionId,
});
