import { defineConfig } from "vite";

// 服务端构建为自包含单文件：只保留 node: 内置模块为外部依赖，
// 部署时无需拷贝 node_modules，产物放在 dist/server/cli.js。
export default defineConfig({
  build: {
    outDir: "dist/server",
    emptyOutDir: true,
    target: "node24",
    minify: false,
    lib: {
      entry: "src/server/cli.ts",
      formats: ["es"],
      fileName: () => "cli.mjs",
    },
    rollupOptions: { external: [/^node:/] },
  },
});
