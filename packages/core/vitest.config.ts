import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./test/setup-pi-inventory.ts"],
    // Profile materialization, authority sockets, and real Git worktree proofs share OS-level
    // resources. Run files sequentially so a release gate validates their behavior instead of
    // racing independent stateful fixtures; semantic wait helpers retain their shorter
    // operation-specific deadlines inside each file.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
