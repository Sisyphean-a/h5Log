import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const processes = [
  spawn(
    process.execPath,
    ["--watch", "--import", "tsx", "packages/app/src/server/cli.ts"],
    { cwd: root, stdio: "inherit" },
  ),
  spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL("../node_modules/vite/bin/vite.js", import.meta.url),
      ),
      "--host",
      "127.0.0.1",
    ],
    {
      cwd: fileURLToPath(new URL("../packages/app/", import.meta.url)),
      stdio: "inherit",
    },
  ),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of processes) child.kill();
  process.exitCode = code;
}
for (const child of processes) {
  child.on("error", (error) => {
    console.error(error);
    stop(1);
  });
  child.on("exit", (code) => {
    if (!stopping) stop(code ?? 1);
  });
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
