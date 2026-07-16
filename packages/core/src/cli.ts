#!/usr/bin/env node

import { KONI_CORE_API_VERSION } from "./index.js";

if (process.argv.includes("--version") || process.argv.includes("-V")) {
  process.stdout.write(`${KONI_CORE_API_VERSION}\n`);
} else {
  process.stderr.write(
    "Koni Core is installed, but this development build has not linked the control-center command surface yet.\n",
  );
  process.exitCode = 1;
}
