import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      vscode: fileURLToPath(new URL("./test/support/vscode-mock.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["test/ts/**/*.test.ts", "test/grammar/**/*.test.ts"],
    restoreMocks: true,
  },
});
