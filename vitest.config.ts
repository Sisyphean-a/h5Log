import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [vue()],
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    testTimeout: 10000,
    restoreMocks: true,
  },
});
