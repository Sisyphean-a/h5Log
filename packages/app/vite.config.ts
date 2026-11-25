import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";
export default defineConfig({
  base: "./",
  plugins: [vue()],
  server: {
    // Rule: 5173 被同机其他项目占用，工作台固定用 5388，避免开发时抢端口。
    port: 5388,
    strictPort: true,
    proxy: { "/api": process.env.H5_LOG_DEV_PROXY ?? "http://127.0.0.1:3685" },
  },
  build: {
    outDir: "dist/web",
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        demo: fileURLToPath(new URL("./demo.html", import.meta.url)),
      },
    },
  },
});
