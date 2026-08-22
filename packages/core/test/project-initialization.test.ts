import { describe, expect, it, vi } from "vitest";
import type { ProfileInstallResult } from "../src/profile/install.js";
import type { ProjectConfigurationStatus } from "../src/operator/authority-bootstrap.js";
import {
  initializeProjectProfile,
  ProjectInitializationError,
} from "../src/operator/project-initialization.js";

const installation: ProfileInstallResult & { cachedPackageRoot: string } = {
  projectConfigRoot: "/canonical/project",
  packageName: "@koni/coding-profile",
  profileVersion: "1.2.3",
  bundleSha256: `sha256:${"a".repeat(64)}`,
  generation: 1,
  added: [],
  updated: [],
  deleted: [],
  unchanged: [],
  preserved: [],
  overlay: [],
  pendingUpstream: [],
  mandatoryRetirements: [],
  previewSha256: `sha256:${"b".repeat(64)}`,
  transactionId: "install-1",
  cachedPackageRoot: "/canonical/.git/koni/profile-cache/package",
};

const validConfiguration: ProjectConfigurationStatus = {
  ok: true,
  projectRoot: "/canonical/project",
  profile: {
    packageName: "@koni/coding-profile",
    profileId: "coding",
    profileVersion: "1.2.3",
    bundleSha256: `sha256:${"a".repeat(64)}`,
  },
  diagnostics: [],
  configuration: {
    sha256: `sha256:${"c".repeat(64)}`,
    effectiveBundleSha256: `sha256:${"d".repeat(64)}`,
    runTypes: ["small"],
    agents: ["lead"],
  },
};

describe("initializeProjectProfile", () => {
  it("installs once and validates the installed canonical project before returning both records", async () => {
    const calls: string[] = [];
    const install = vi.fn(async (input: { projectRoot: string; profilePackageRoot: string }) => {
      calls.push(`install:${input.projectRoot}:${input.profilePackageRoot}`);
      return installation;
    });
    const validate = vi.fn(async (projectRoot: string) => {
      calls.push(`validate:${projectRoot}`);
      return validConfiguration;
    });

    await expect(
      initializeProjectProfile(
        { projectRoot: "/nested/project", profilePackageRoot: "/profiles/coding" },
        { install, validate },
      ),
    ).resolves.toEqual({ installation, validation: validConfiguration });

    expect(install).toHaveBeenCalledOnce();
    expect(validate).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      "install:/nested/project:/profiles/coding",
      "validate:/canonical/project",
    ]);
  });

  it("throws one typed error with the published installation and exact invalid diagnostics", async () => {
    const invalidConfiguration: ProjectConfigurationStatus = {
      ...validConfiguration,
      ok: false,
      diagnostics: [
        {
          code: "missing_agent",
          severity: "error",
          path: "/agents/lead",
          message: "agent missing",
        },
        { code: "invalid_rule", severity: "error", path: "/rules/0", message: "rule invalid" },
      ],
    };
    const install = vi.fn(async () => installation);
    const validate = vi.fn(async () => invalidConfiguration);

    const error = await initializeProjectProfile(
      { projectRoot: "/project", profilePackageRoot: "/profiles/coding" },
      { install, validate },
    ).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ProjectInitializationError);
    expect(error).toMatchObject({
      code: "configuration_invalid",
      installation,
      diagnostics: [
        { path: "/agents/lead", message: "agent missing" },
        { path: "/rules/0", message: "rule invalid" },
      ],
    });
    expect(install).toHaveBeenCalledOnce();
    expect(validate).toHaveBeenCalledOnce();
  });
});
