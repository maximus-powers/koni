#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatFatalError, runKoniPiHost } from "./main.js";
import { SecretRedactor } from "./redaction.js";

export { formatFatalError, runKoniPiHost } from "./main.js";
export { koniOpenAICodexProvider } from "./openai-codex-provider.js";

function isDirectExecution(): boolean {
  const executable = process.argv[1];
  if (executable === undefined) return false;
  try {
    return realpathSync(resolve(executable)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  const redactor = new SecretRedactor();
  runKoniPiHost(redactor).catch((error: unknown) => {
    process.stderr.write(formatFatalError(error, redactor));
    process.exitCode = 1;
  });
}
