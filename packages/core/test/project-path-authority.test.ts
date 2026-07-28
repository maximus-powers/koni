import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProjectPathAuthority,
  type ProjectPathAuthorityError,
} from "../src/shared/project-path-authority.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("bounded project path authority", () => {
  it("does not inspect the project root until a path comparison needs it", () => {
    const authority = createProjectPathAuthority("/definitely/not/a/koni/project");
    expect(authority).toBeDefined();
    expect(() => authority.pathsEqual("src/a.ts", "src/a.ts")).toThrowError(
      expect.objectContaining<Partial<ProjectPathAuthorityError>>({ code: "project_root" }),
    );
  });

  it("reuses one physical identity snapshot across repeated comparisons", async () => {
    const authority = createProjectPathAuthority(await projectRoot());
    for (let index = 0; index < 10_000; index += 1) {
      expect(authority.pathsOverlap("src/a.ts", "src/b.ts")).toBe(false);
    }
  });

  it("fails closed when one projection exceeds its distinct-path budget", async () => {
    const authority = createProjectPathAuthority(await projectRoot());
    for (let index = 0; index < 4_096; index += 1) {
      expect(authority.pathsEqual(`generated/${index}.ts`, `generated/${index}.ts`)).toBe(true);
    }
    expect(() =>
      authority.pathsEqual("generated/overflow.ts", "generated/overflow.ts"),
    ).toThrowError(
      expect.objectContaining<Partial<ProjectPathAuthorityError>>({ code: "path_budget" }),
    );
  });

  it("fails closed when one projection exceeds its comparison budget", async () => {
    const authority = createProjectPathAuthority(await projectRoot());
    for (let index = 0; index < 1_048_576; index += 1) {
      authority.pathsEqual("src/a.ts", "src/a.ts");
    }
    expect(() => authority.pathsEqual("src/a.ts", "src/a.ts")).toThrowError(
      expect.objectContaining<Partial<ProjectPathAuthorityError>>({ code: "comparison_budget" }),
    );
  });
});

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "koni-path-authority-"));
  roots.push(root);
  return root;
}
