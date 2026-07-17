import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Profile materialization and real Git worktree proofs contend under the full parallel suite.
    // Semantic wait helpers retain their shorter operation-specific deadlines.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
