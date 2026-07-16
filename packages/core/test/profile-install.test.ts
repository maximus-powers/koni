import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installProfile, ProfileInstallError } from "../src/profile/install.js";

const roots: string[] = [];
const codingProfile = path.resolve(import.meta.dirname, "../../coding-profile");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("profile installation and guarded upgrades", () => {
  it("materializes a verified profile without changing Pi settings", async () => {
    const project = await temporary("project");
    await writeFile(path.join(project, ".pi-settings-sentinel"), "preserve\n");
    const result = await installProfile(project, codingProfile);
    expect(result.packageName).toBe("@koni/coding-profile");
    expect(result.added).toContain("project.yaml");
    expect(await readFile(path.join(project, ".pi-settings-sentinel"), "utf8")).toBe("preserve\n");
    expect(await readFile(path.join(project, ".koni", "project.yaml"), "utf8")).toContain(
      "Software project",
    );
  });

  it("preserves project edits and stages changed upstream defaults separately", async () => {
    const project = await temporary("project");
    await installProfile(project, codingProfile);
    const projectYaml = path.join(project, ".koni", "project.yaml");
    await writeFile(projectYaml, `${await readFile(projectYaml, "utf8")}# project override\n`);

    const packageCopy = await temporary("package");
    await cp(codingProfile, packageCopy, { recursive: true });
    // The same package is enough to prove modified local bytes are preserved;
    // no manifest mutation is permitted without recomputing its signed inventory.
    const result = await installProfile(project, packageCopy);
    expect(result.preserved).toContain("project.yaml");
    expect(await readFile(projectYaml, "utf8")).toContain("# project override");
    expect(result.pendingUpstream.find((item) => item.path === "project.yaml")?.reason).toBe(
      "modified",
    );
  });

  it("refuses to overwrite an unmanaged .koni tree", async () => {
    const project = await temporary("project");
    await cp(codingProfile + "/koni/baseline", path.join(project, ".koni"), { recursive: true });
    await expect(installProfile(project, codingProfile)).rejects.toMatchObject({
      code: "unmanaged_project",
    } satisfies Partial<ProfileInstallError>);
  });
});

async function temporary(label: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `koni-${label}-`));
  roots.push(root);
  return root;
}
