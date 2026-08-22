import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { exclusiveTestFiles, exclusiveTestReasons } from "./test-lanes.js";

const testDirectory = fileURLToPath(new URL("./", import.meta.url));

describe("core test lane classification", () => {
  it("classifies every direct test file exactly once and documents each exclusive resource", async () => {
    const allTests = (await readdir(testDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
      .map((entry) => path.posix.join("test", entry.name));
    const exclusiveFiles: readonly string[] = exclusiveTestFiles;
    const parallelFiles = allTests.filter((file) => !exclusiveFiles.includes(file));

    expect(new Set(exclusiveTestFiles).size).toBe(exclusiveTestFiles.length);
    expect(exclusiveTestFiles.every((file) => allTests.includes(file))).toBe(true);
    expect(parallelFiles).not.toHaveLength(0);
    expect([...exclusiveTestFiles, ...parallelFiles].sort()).toEqual(allTests.sort());

    expect(Object.keys(exclusiveTestReasons).sort()).toEqual([...exclusiveTestFiles].sort());
    expect(
      exclusiveTestFiles.every((file) => {
        const reason = exclusiveTestReasons[file];
        return typeof reason === "string" && reason.trim().length > 0 && reason.length <= 160;
      }),
    ).toBe(true);
  });
});
