import { configDefaults, defineConfig } from "vitest/config";
import { exclusiveTestFiles } from "./test/test-lanes.js";
import { coreTestDefaults } from "./vitest.config.js";

export default defineConfig({
  test: {
    ...coreTestDefaults,
    fileParallelism: true,
    maxWorkers: 4,
    exclude: [...configDefaults.exclude, ...exclusiveTestFiles],
  },
});
