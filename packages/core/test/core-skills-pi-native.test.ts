import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const skillsRoot = path.resolve(import.meta.dirname, "../skills");

describe("Koni's Pi-native skills", () => {
  it("do not teach the retired schema-2 persona or vendored-resource model", async () => {
    const files = await markdownFiles(skillsRoot);
    const violations: string[] = [];
    const retired = [
      /schema[- ]2/giu,
      /\.codex\/koni/gu,
      /^\s*personas?:/gmu,
      /resources\/skills/gu,
      /pi-packages\.yaml/gu,
    ];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const pattern of retired) {
        if (pattern.test(source)) violations.push(`${path.relative(skillsRoot, file)}: ${pattern}`);
        pattern.lastIndex = 0;
      }
    }
    expect(violations).toEqual([]);
  });

  it("teaches profile authors to preserve authenticated skill reads across containment", async () => {
    const source = await readFile(
      path.join(skillsRoot, "configure-koni/references/agents-and-skills.md"),
      "utf8",
    );
    const normalized = source.replace(/\s+/gu, " ");

    expect(normalized).toContain(
      "A complete authenticated skill read remains satisfied across same-scope recovery and compaction",
    );
    expect(normalized).toContain(
      "Do not raise token budgets or remove useful skills to compensate for repeated immutable resource reads",
    );
    expect(normalized).toContain(
      "Narrow a role's skill filter only when the reusable technique itself is outside that role",
    );
  });
});

async function markdownFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && entry.name.endsWith(".md")) output.push(absolute);
    }
  };
  await walk(root);
  return output.sort();
}
