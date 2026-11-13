import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "test/fake-app/**/*.ts"],
      reporter: ["text", "lcov"],
    },
  },
});
