import { defineConfig } from "vitest/config";
import { exclusiveTestFiles } from "./test/test-lanes.js";
import { coreTestDefaults } from "./vitest.config.js";

export default defineConfig({
  test: {
    ...coreTestDefaults,
    include: [...exclusiveTestFiles],
    fileParallelism: false,
    maxWorkers: 1,
  },
});
