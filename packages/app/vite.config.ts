import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:3000" },
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
