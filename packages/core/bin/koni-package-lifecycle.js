#!/usr/bin/env node

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const action = process.argv[2];
if ((action !== "activate" && action !== "remove") || process.argv.length !== 3) {
  process.stderr.write("koni package lifecycle: expected activate or remove\n");
  process.exitCode = 1;
} else {
  try {
    await run(action);
  } catch (error) {
    process.stderr.write(
      `koni package lifecycle ${action} failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

async function run(requestedAction) {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const agentDir = path.resolve(
    process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"),
  );
  const piPackageRoot = path.join(agentDir, "npm", "node_modules", "@koni", "core");
  if (!isWithin(piPackageRoot, packageRoot)) return;

  const { activateGlobalLauncher, isPiUserPackageInstallation, removeGlobalLauncher } =
    await import("../dist/installation/global-launcher.js");
  if (!isPiUserPackageInstallation({ packageRoot, agentDir })) return;
  const environment = {
    packageRoot,
    agentDir,
    pathValue: process.env.PATH ?? "",
    platform: process.platform,
  };
  if (requestedAction === "activate") {
    await activateGlobalLauncher(environment);
  } else {
    await removeGlobalLauncher(environment);
  }
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}
