import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: {
    "@": fileURLToPath(new URL("./src", import.meta.url)),
    "server-only": fileURLToPath(new URL("./tests/server-only.ts", import.meta.url)),
  } },
  test: {
    projects: [
      { extends: true, test: { name: "unit", environment: "node", include: ["tests/**/*.test.ts"], exclude: ["tests/db/**"] } },
      { extends: true, test: { name: "db", environment: "node", include: ["tests/db/**/*.test.ts"], fileParallelism: false, testTimeout: 15_000 } },
    ],
  },
});
