import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.spec.ts"],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      // 測試不呼叫真正的 Workers AI：AI_MODE=fake 讓管線回傳可預期的假結果。
      miniflare: { bindings: { AI_MODE: "fake", MAX_QUESTIONS: "50", DAILY_NEURON_CEILING: "9000" } },
    }),
  ],
});
