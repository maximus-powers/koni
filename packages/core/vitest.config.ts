import { defineConfig } from "vitest/config";

export const coreTestDefaults = {
  setupFiles: ["./test/setup-pi-inventory.ts"],
  pool: "forks" as const,
  testTimeout: 20_000,
  hookTimeout: 20_000,
};

export default defineConfig({ test: coreTestDefaults });
