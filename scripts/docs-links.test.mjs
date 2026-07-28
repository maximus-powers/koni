import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const documentationRoots = [
  path.join(repositoryRoot, "README.md"),
  path.join(repositoryRoot, "CODE_OF_CONDUCT.md"),
  path.join(repositoryRoot, "CONTRIBUTING.md"),
  path.join(repositoryRoot, "SECURITY.md"),
  path.join(repositoryRoot, "SUPPORT.md"),
  path.join(repositoryRoot, "docs"),
  path.join(repositoryRoot, "packages/coding-profile/README.md"),
  path.join(repositoryRoot, "packages/core/README.md"),
  path.join(repositoryRoot, "packages/research-profile/README.md"),
];

test("local Markdown links resolve to repository files", async () => {
  const failures = [];
  for (const markdownPath of await listMarkdownFiles(documentationRoots)) {
    const contents = await readFile(markdownPath, "utf8");
    for (const target of markdownLinkTargets(contents)) {
      if (isExternalOrDocumentAnchor(target)) continue;
      const decodedTarget = decodeURIComponent(target.split("#", 1)[0]);
      const absoluteTarget = path.resolve(path.dirname(markdownPath), decodedTarget);
      if (!isWithinRepository(absoluteTarget)) {
        failures.push(`${relative(markdownPath)}: link escapes the repository: ${target}`);
        continue;
      }
      try {
        await access(absoluteTarget);
      } catch {
        failures.push(`${relative(markdownPath)}: missing link target: ${target}`);
      }
    }
  }

  assert.deepEqual(failures, [], failures.join("\n"));
});

function markdownLinkTargets(contents) {
  return [...contents.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/gu)]
    .map((match) => match[1])
    .filter((target) => target !== undefined);
}

function isExternalOrDocumentAnchor(target) {
  return target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/iu.test(target) || target.startsWith("//");
}

function isWithinRepository(absolutePath) {
  const relativePath = path.relative(repositoryRoot, absolutePath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${path.sep}`) &&
      relativePath !== ".." &&
      !path.isAbsolute(relativePath))
  );
}

function relative(absolutePath) {
  return path.relative(repositoryRoot, absolutePath).split(path.sep).join("/");
}

async function listMarkdownFiles(roots) {
  const output = [];
  for (const root of roots) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => undefined);
    if (entries === undefined) {
      output.push(root);
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "superpowers") continue;
      const absolutePath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        output.push(...(await listMarkdownFiles([absolutePath])));
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        output.push(absolutePath);
      }
    }
  }
  return output.sort();
}
