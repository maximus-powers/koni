import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { assertStandaloneBundle } from "./artifact-policy.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDirectory = resolve(packageRoot, "dist");
const bundlePath = resolve(distDirectory, "koni-pi-host.mjs");
const checksumPath = resolve(distDirectory, "koni-pi-host.sha256");

await rm(distDirectory, { recursive: true, force: true });
await mkdir(distDirectory, { recursive: true });

const result = await build({
  absWorkingDir: packageRoot,
  entryPoints: ["src/entry.ts"],
  outfile: bundlePath,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22.19",
  alias: {
    "@earendil-works/pi-ai/compat": resolve(packageRoot, "src/pi-compat-shim.ts"),
  },
  banner: {
    js: 'import { createRequire as __koniCreateRequire } from "node:module";\nconst require = __koniCreateRequire(import.meta.url);',
  },
  packages: "bundle",
  conditions: ["node", "import", "default"],
  treeShaking: true,
  charset: "utf8",
  legalComments: "eof",
  sourcemap: false,
  metafile: true,
  logLevel: "warning",
});

const output = Object.entries(result.metafile.outputs).find(
  ([path]) => resolve(packageRoot, path) === bundlePath,
);
if (!output) throw new Error("esbuild did not report the expected Koni Pi host bundle");
const unexpectedExternals = output[1].imports
  .filter((entry) => entry.external && !isBuiltin(entry.path))
  .map((entry) => entry.path);
if (unexpectedExternals.length > 0) {
  throw new Error(`bundle retained non-Node imports: ${unexpectedExternals.join(", ")}`);
}

const bundle = await readFile(bundlePath);
const bundleText = bundle.toString("utf8");
assertStandaloneBundle(bundleText);
const digest = createHash("sha256").update(bundle).digest("hex");
await writeFile(checksumPath, `${digest}  koni-pi-host.mjs\n`, "utf8");
await chmod(bundlePath, 0o755);

process.stdout.write(`built dist/koni-pi-host.mjs (${bundle.byteLength} bytes, sha256 ${digest})\n`);
