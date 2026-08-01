import { realpath } from "node:fs/promises";
import path from "node:path";
import { RuntimeIdentityError } from "./identity.js";

const VERSIONED_LAUNCHER_TAIL = path.join(
  "package-root",
  "node_modules",
  "@koni",
  "core",
  "bin",
  "koni.js",
);
export const KONI_ACTIVE_INSTALL_LAUNCHER_ENV = "KONI_ACTIVE_INSTALL_LAUNCHER" as const;
export const KONI_EXPECTED_INSTALL_LAUNCHER_ENV = "KONI_EXPECTED_INSTALL_LAUNCHER" as const;

export interface ActiveInstallationBinding {
  activeLauncherPath: string;
  expectedLauncherPath: string;
}

export function activeInstallationEnvironment(
  binding: ActiveInstallationBinding,
): Record<string, string> {
  validateBinding(binding);
  return {
    [KONI_ACTIVE_INSTALL_LAUNCHER_ENV]: binding.activeLauncherPath,
    [KONI_EXPECTED_INSTALL_LAUNCHER_ENV]: binding.expectedLauncherPath,
  };
}

export function activeInstallationFromEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
): ActiveInstallationBinding | undefined {
  const activeLauncherPath = environment[KONI_ACTIVE_INSTALL_LAUNCHER_ENV];
  const expectedLauncherPath = environment[KONI_EXPECTED_INSTALL_LAUNCHER_ENV];
  if (activeLauncherPath === undefined && expectedLauncherPath === undefined) return undefined;
  if (activeLauncherPath === undefined || expectedLauncherPath === undefined) {
    throw new RuntimeIdentityError(
      "core_install_binding",
      "Koni authority received a partial active-installation binding",
    );
  }
  const binding = { activeLauncherPath, expectedLauncherPath };
  validateBinding(binding);
  return binding;
}

/**
 * Bind a content-addressed Koni development package to the atomically activated
 * prefix launcher. Ordinary source and package-manager layouts have no such
 * prefix-wide activation boundary and therefore return no binding.
 */
export async function bindVersionedActiveInstallation(
  candidateLauncher: string,
): Promise<ActiveInstallationBinding | undefined> {
  const expectedLauncherPath = await realpath(candidateLauncher);
  let current = path.dirname(expectedLauncherPath);
  while (true) {
    const parent = path.dirname(current);
    if (path.basename(parent) === "versions") {
      if (path.relative(current, expectedLauncherPath) !== VERSIONED_LAUNCHER_TAIL) {
        return undefined;
      }
      const koniShareRoot = path.dirname(parent);
      const shareRoot = path.dirname(koniShareRoot);
      if (path.basename(koniShareRoot) !== "koni" || path.basename(shareRoot) !== "share") {
        return undefined;
      }
      const prefix = path.dirname(shareRoot);
      return {
        activeLauncherPath: path.join(prefix, "bin", "koni"),
        expectedLauncherPath,
      };
    }
    if (parent === current) return undefined;
    current = parent;
  }
}

export async function assertActiveInstallationCurrent(
  binding: ActiveInstallationBinding,
): Promise<void> {
  let activeLauncherPath: string;
  try {
    activeLauncherPath = await realpath(binding.activeLauncherPath);
  } catch {
    throw supersededInstallError(binding);
  }
  if (activeLauncherPath !== binding.expectedLauncherPath) {
    throw supersededInstallError(binding);
  }
}

export async function waitForActiveInstallationSupersession(
  binding: ActiveInstallationBinding,
  options: { pollIntervalMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new RangeError("active installation poll interval must be a positive integer");
  }
  while (true) {
    try {
      await assertActiveInstallationCurrent(binding);
    } catch (error) {
      if (error instanceof RuntimeIdentityError && error.code === "core_install_superseded") return;
      throw error;
    }
    await abortableWait(pollIntervalMs, options.signal);
  }
}

function supersededInstallError(binding: ActiveInstallationBinding): RuntimeIdentityError {
  return new RuntimeIdentityError(
    "core_install_superseded",
    `Koni Core at ${binding.expectedLauncherPath} is no longer the active installation; ` +
      `reload Pi so ${binding.activeLauncherPath} can start the current authority`,
  );
}

function validateBinding(binding: ActiveInstallationBinding): void {
  if (
    !validAbsolutePath(binding.activeLauncherPath) ||
    !validAbsolutePath(binding.expectedLauncherPath)
  ) {
    throw new RuntimeIdentityError(
      "core_install_binding",
      "Koni active-installation binding contains an invalid launcher path",
    );
  }
}

function validAbsolutePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("\0") &&
    path.isAbsolute(value) &&
    path.normalize(value) === value
  );
}

function abortableWait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) {
    return Promise.reject(new DOMException("active installation monitor aborted", "AbortError"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(settle, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new DOMException("active installation monitor aborted", "AbortError"));
    };
    function settle(): void {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}
