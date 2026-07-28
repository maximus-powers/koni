import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const COMPLETION = ".koni-package-bundle.json";
const PROTOCOL = "koni.dev-package-bundle.v1";
const EXPECTED_PACKAGES = ["@koni/core", "@koni/coding-profile", "@koni/research-profile"];

const [command, rootInput, bundleId] = process.argv.slice(2);
if (
  (command !== "seal" && command !== "verify") ||
  !rootInput ||
  !/^[a-f0-9]{64}$/u.test(bundleId ?? "")
) {
  throw new Error("usage: dev-package-bundle.mjs seal|verify PACKAGE_ROOT SHA256");
}
const root = path.resolve(rootInput);
await assertRealDirectory(root);
if (command === "seal") await seal(root, bundleId);
else await verify(root, bundleId);

async function seal(root, bundleId) {
  const completionPath = path.join(root, COMPLETION);
  try {
    await lstat(completionPath);
    throw new Error("refusing to reseal a package root that already has a completion manifest");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const packages = await validatePackages(root);
  const treeSha256 = await hashTree(root);
  const manifest = { protocol: PROTOCOL, bundle_id: bundleId, tree_sha256: treeSha256, packages };
  await writeFile(completionPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  await verify(root, bundleId);
}

async function verify(root, bundleId) {
  const completionPath = path.join(root, COMPLETION);
  const metadata = await lstat(completionPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024) {
    throw new Error("package completion manifest must be a bounded real file");
  }
  let manifest;
  try {
    manifest = JSON.parse(await readFile(completionPath, "utf8"));
  } catch {
    throw new Error("package completion manifest is not valid JSON");
  }
  if (
    manifest?.protocol !== PROTOCOL ||
    manifest.bundle_id !== bundleId ||
    !/^[a-f0-9]{64}$/u.test(manifest.tree_sha256 ?? "")
  )
    throw new Error("package completion manifest identity is invalid");
  const packages = await validatePackages(root);
  if (JSON.stringify(packages) !== JSON.stringify(manifest.packages)) {
    throw new Error("package completion manifest does not match the installed package identities");
  }
  const treeSha256 = await hashTree(root);
  if (treeSha256 !== manifest.tree_sha256)
    throw new Error("package root content differs from its completion manifest");
}

async function validatePackages(root) {
  const packages = [];
  for (const name of EXPECTED_PACKAGES) {
    const packageRoot = path.join(root, "node_modules", ...name.split("/"));
    await assertRealDirectory(packageRoot);
    const manifestPath = path.join(packageRoot, "package.json");
    const metadata = await lstat(manifestPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024) {
      throw new Error(`${name} has an unsafe package manifest`);
    }
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (
      manifest.name !== name ||
      typeof manifest.version !== "string" ||
      manifest.version.length === 0
    ) {
      throw new Error(`package root identity mismatch for ${name}`);
    }
    packages.push({ name, version: manifest.version });
  }
  return packages;
}

async function hashTree(root) {
  const hash = createHash("sha256");
  const files = await collectFiles(root);
  for (const relative of files) {
    if (relative === COMPLETION) continue;
    const bytes = await readFile(path.join(root, relative));
    hash.update(relative, "utf8");
    hash.update("\0", "utf8");
    hash.update(String(bytes.length), "utf8");
    hash.update("\0", "utf8");
    hash.update(bytes);
  }
  return hash.digest("hex");
}

async function collectFiles(root, current = root) {
  const result = [];
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) throw new Error(`package root contains symlink: ${relative}`);
    if (metadata.isDirectory()) {
      result.push(...(await collectFiles(root, absolute)));
      continue;
    }
    if (!metadata.isFile()) throw new Error(`package root contains unsupported entry: ${relative}`);
    if (
      /node_modules\/(?:@earendil-works\/pi-(?:agent-core|ai|coding-agent|tui)|typebox)(?:\/|$)/u.test(
        relative,
      )
    ) {
      throw new Error(`package root contains Pi-owned host peer: ${relative}`);
    }
    result.push(relative);
  }
  return result;
}

async function assertRealDirectory(target) {
  const metadata = await lstat(target);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`expected a real package directory: ${target}`);
  }
}
