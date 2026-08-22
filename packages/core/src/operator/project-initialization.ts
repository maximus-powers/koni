import {
  validateProjectConfiguration,
  type ProjectConfigurationStatus,
} from "./authority-bootstrap.js";
import { installAndCacheProfile } from "./profile-source.js";
import type { CompilerDiagnostic } from "../shared/diagnostics.js";

export interface InitializeProjectProfileInput {
  projectRoot: string;
  profilePackageRoot: string;
}

export type SuccessfulProjectConfigurationStatus = ProjectConfigurationStatus & {
  ok: true;
  configuration: NonNullable<ProjectConfigurationStatus["configuration"]>;
};

export interface InitializedProjectProfile {
  installation: Awaited<ReturnType<typeof installAndCacheProfile>>;
  validation: SuccessfulProjectConfigurationStatus;
}

export class ProjectInitializationError extends Error {
  public readonly code = "configuration_invalid";
  public readonly installation: Awaited<ReturnType<typeof installAndCacheProfile>>;
  public readonly diagnostics: readonly CompilerDiagnostic[];

  public constructor(
    installation: Awaited<ReturnType<typeof installAndCacheProfile>>,
    diagnostics: readonly CompilerDiagnostic[],
  ) {
    super(diagnostics.map(({ path, message }) => `${path}: ${message}`).join("\n"));
    this.name = "ProjectInitializationError";
    this.installation = installation;
    this.diagnostics = diagnostics;
  }
}

export async function initializeProjectProfile(
  input: InitializeProjectProfileInput,
  dependencies: {
    install: typeof installAndCacheProfile;
    validate: typeof validateProjectConfiguration;
  } = {
    install: installAndCacheProfile,
    validate: validateProjectConfiguration,
  },
): Promise<InitializedProjectProfile> {
  const installation = await dependencies.install(input);
  const validation = await dependencies.validate(installation.projectConfigRoot);
  if (!validConfiguration(validation)) {
    throw new ProjectInitializationError(installation, validation.diagnostics);
  }
  return { installation, validation };
}

function validConfiguration(
  validation: ProjectConfigurationStatus,
): validation is SuccessfulProjectConfigurationStatus {
  return validation.ok === true && validation.configuration !== undefined;
}
