import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@kikoe/core": here("./packages/core/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    testTimeout: 10_000,
    env: {
      // No test ever reads a real credential or calls a vendor's usage
      // endpoint. Set here rather than per file so a test written later cannot
      // forget it — the usage tests build their own providers explicitly and
      // are unaffected. The sibling rule is KIKOE_CLAUDE_DIR, which each test
      // file still sets for itself because it points at that file's temp home.
      KIKOE_USAGE: "off",
    },
  },
});
