import path from "node:path";

/**
 * An explicit path rule used at the Git publication boundary.
 *
 * Koni deliberately does not guess whether a configured path names a file,
 * directory, or glob. The compiler must say which semantic it intends.
 */
export type GitPathRule =
  | { kind: "exact"; path: string }
  | { kind: "prefix"; path: string }
  | { kind: "glob"; pattern: string };

export interface GitPathScope {
  allowed: readonly GitPathRule[];
  /** Compiler-owned paths always win over an allow rule. */
  compilerOwned?: readonly GitPathRule[];
}

export interface GitPathScopeInspection {
  accepted: boolean;
  changedPaths: string[];
  outOfScopePaths: string[];
  compilerOwnedPaths: string[];
}

/** Paths which are authority/configuration state in every profile. */
export const DEFAULT_COMPILER_OWNED_PATHS: readonly GitPathRule[] = Object.freeze([
  { kind: "exact", path: ".git" },
  { kind: "prefix", path: ".git" },
  { kind: "exact", path: ".koni" },
  { kind: "prefix", path: ".koni" },
  { kind: "exact", path: ".codex/koni" },
  { kind: "prefix", path: ".codex/koni" },
]);

export function inspectGitPathScope(
  changedPaths: readonly string[],
  scope: GitPathScope,
): GitPathScopeInspection {
  const allowed = scope.allowed.map(compileRule);
  const compilerOwned = [
    ...DEFAULT_COMPILER_OWNED_PATHS,
    ...(scope.compilerOwned ?? []),
  ].map(compileRule);
  const changed = [...new Set(changedPaths.map(normalizeGitPath))].sort();
  const deniedByOwnership: string[] = [];
  const deniedByScope: string[] = [];
  for (const candidate of changed) {
    if (compilerOwned.some((matches) => matches(candidate))) {
      deniedByOwnership.push(candidate);
    } else if (!allowed.some((matches) => matches(candidate))) {
      deniedByScope.push(candidate);
    }
  }
  return {
    accepted: deniedByOwnership.length === 0 && deniedByScope.length === 0,
    changedPaths: changed,
    outOfScopePaths: deniedByScope,
    compilerOwnedPaths: deniedByOwnership,
  };
}

export function normalizeGitPath(value: string): string {
  if (value.length === 0 || value.length > 16 * 1024 || value.includes("\0")) {
    throw new Error("Git path is empty, too large, or contains NUL");
  }
  if (value.includes("\\")) {
    throw new Error(`Git path must use forward slashes: ${value}`);
  }
  if (value.startsWith("/") || /^[A-Za-z]:\//u.test(value)) {
    throw new Error(`Git path must be repository-relative: ${value}`);
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized !== value.replace(/^\.\//u, "")
  ) {
    throw new Error(`Git path is not canonical and repository-relative: ${value}`);
  }
  return normalized;
}

function compileRule(rule: GitPathRule): (candidate: string) => boolean {
  if (rule.kind === "exact") {
    const expected = normalizeGitPath(rule.path);
    return (candidate) => candidate === expected;
  }
  if (rule.kind === "prefix") {
    const prefix = normalizeGitPath(rule.path).replace(/\/$/u, "");
    return (candidate) => candidate === prefix || candidate.startsWith(`${prefix}/`);
  }
  const pattern = normalizeGlob(rule.pattern);
  const expression = globExpression(pattern);
  return (candidate) => expression.test(candidate);
}

function normalizeGlob(value: string): string {
  if (value.length === 0 || value.length > 16 * 1024 || value.includes("\0")) {
    throw new Error("Git glob is empty, too large, or contains NUL");
  }
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:\//u.test(value)) {
    throw new Error(`Git glob must be repository-relative and use forward slashes: ${value}`);
  }
  for (const component of value.split("/")) {
    if (component === "" || component === "." || component === "..") {
      throw new Error(`Git glob contains an unsafe component: ${value}`);
    }
  }
  return value;
}

function globExpression(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        index += 1;
        if (pattern[index + 1] === "/") {
          index += 1;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += escapeRegularExpression(character);
    }
  }
  return new RegExp(`${source}$`, "u");
}

function escapeRegularExpression(character: string): string {
  return /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character;
}
