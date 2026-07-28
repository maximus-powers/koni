import { lstatSync, realpathSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import path from "node:path";

export class ProjectPathAuthorityError extends Error {
  public readonly code: string;

  public constructor(code: string, message: string) {
    super(message);
    this.name = "ProjectPathAuthorityError";
    this.code = code;
  }
}

interface ExistingPrefixIdentity {
  depth: number;
  device: bigint;
  inode: bigint;
}

interface ProjectPathIdentity {
  normalized: string;
  components: string[];
  existingPrefixes: ExistingPrefixIdentity[];
  unresolvedComponents: string[];
}

export interface ProjectPathAuthority {
  pathsOverlap(left: string, right: string): boolean;
  pathsEqual(left: string, right: string): boolean;
}

const MAX_CACHED_PATH_IDENTITIES = 4_096;
const MAX_PATH_COMPARISONS = 1_048_576;

/** Create one bounded physical-path snapshot for a compiler or scheduler projection. */
export function createProjectPathAuthority(projectRoot: string): ProjectPathAuthority {
  return new CachedProjectPathAuthority(projectRoot);
}

/** Normalize the one project-relative path vocabulary accepted by compiler authority. */
export function normalizeProjectRelativePath(value: string): string {
  if (value === ".") return value;
  if (value.length === 0 || value.startsWith("/") || value.includes("\\") || value.includes("\0")) {
    throw new ProjectPathAuthorityError(
      "path_shape",
      `path is not normalized and project-relative: ${value}`,
    );
  }
  const components = value.split("/");
  if (
    components.some(
      (component) => component.length === 0 || component === "." || component === "..",
    )
  ) {
    throw new ProjectPathAuthorityError(
      "path_shape",
      `path is not normalized and project-relative: ${value}`,
    );
  }
  return components.join("/");
}

/**
 * Compare complete project path authority, not just spellings.
 *
 * Existing prefixes are bound by device/inode, which catches hard links and filesystem aliases.
 * Symlink components fail closed. Missing suffixes are compared case- and Unicode-conservatively
 * beneath their last existing physical identity.
 */
export function projectAuthorityPathsOverlap(
  projectRoot: string,
  left: string,
  right: string,
): boolean {
  return createProjectPathAuthority(projectRoot).pathsOverlap(left, right);
}

export function projectAuthorityPathsEqual(
  projectRoot: string,
  left: string,
  right: string,
): boolean {
  return createProjectPathAuthority(projectRoot).pathsEqual(left, right);
}

class CachedProjectPathAuthority implements ProjectPathAuthority {
  readonly #projectRoot: string;
  #canonicalRoot?: string;
  #rootMetadata?: BigIntStats;
  readonly #identities = new Map<string, ProjectPathIdentity>();
  #comparisons = 0;

  public constructor(projectRoot: string) {
    this.#projectRoot = projectRoot;
  }

  #root(): { canonicalRoot: string; rootMetadata: BigIntStats } {
    if (this.#canonicalRoot !== undefined && this.#rootMetadata !== undefined) {
      return { canonicalRoot: this.#canonicalRoot, rootMetadata: this.#rootMetadata };
    }
    try {
      this.#canonicalRoot = realpathSync(path.resolve(this.#projectRoot));
    } catch {
      throw new ProjectPathAuthorityError(
        "project_root",
        "project root cannot be resolved for path authority comparison",
      );
    }
    this.#rootMetadata = lstatBigInt(this.#canonicalRoot, "project root");
    if (!this.#rootMetadata.isDirectory() || this.#rootMetadata.isSymbolicLink()) {
      throw new ProjectPathAuthorityError("project_root", "project root is not one real directory");
    }
    return { canonicalRoot: this.#canonicalRoot, rootMetadata: this.#rootMetadata };
  }

  public pathsOverlap(left: string, right: string): boolean {
    this.#consumeComparison();
    return identitiesOverlap(this.#identity(left), this.#identity(right));
  }

  public pathsEqual(left: string, right: string): boolean {
    this.#consumeComparison();
    return identitiesEqual(this.#identity(left), this.#identity(right));
  }

  #identity(value: string): ProjectPathIdentity {
    const normalized = normalizeProjectRelativePath(value);
    const existing = this.#identities.get(normalized);
    if (existing !== undefined) return existing;
    if (this.#identities.size >= MAX_CACHED_PATH_IDENTITIES) {
      throw new ProjectPathAuthorityError(
        "path_budget",
        `path authority exceeds ${MAX_CACHED_PATH_IDENTITIES} distinct project paths`,
      );
    }
    const { canonicalRoot, rootMetadata } = this.#root();
    const identity = projectPathIdentity(canonicalRoot, rootMetadata, normalized);
    this.#identities.set(normalized, identity);
    return identity;
  }

  #consumeComparison(): void {
    this.#comparisons += 1;
    if (this.#comparisons > MAX_PATH_COMPARISONS) {
      throw new ProjectPathAuthorityError(
        "comparison_budget",
        `path authority exceeds ${MAX_PATH_COMPARISONS} comparisons`,
      );
    }
  }
}

function projectPathIdentity(
  canonicalRoot: string,
  rootMetadata: BigIntStats,
  normalized: string,
): ProjectPathIdentity {
  const components = normalized === "." ? [] : normalized.split("/");
  const existingPrefixes: ExistingPrefixIdentity[] = [
    {
      depth: 0,
      device: rootMetadata.dev,
      inode: rootMetadata.ino,
    },
  ];
  let current = canonicalRoot;
  for (const [index, component] of components.entries()) {
    current = path.join(current, component);
    let metadata: ReturnType<typeof lstatBigInt>;
    try {
      metadata = lstatBigInt(current, `project path ${normalized}`);
    } catch (error) {
      if (error instanceof ProjectPathAuthorityError && error.code === "missing") break;
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      throw new ProjectPathAuthorityError(
        "symlink",
        `project path authority rejects symlink component: ${components.slice(0, index + 1).join("/")}`,
      );
    }
    existingPrefixes.push({ depth: index + 1, device: metadata.dev, inode: metadata.ino });
  }
  const resolvedDepth = existingPrefixes.at(-1)?.depth ?? 0;
  return {
    normalized,
    components,
    existingPrefixes,
    unresolvedComponents: components.slice(resolvedDepth),
  };
}

function lstatBigInt(value: string, label: string): BigIntStats {
  try {
    return lstatSync(value, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ProjectPathAuthorityError("missing", `${label} does not exist`);
    }
    throw new ProjectPathAuthorityError("filesystem", `${label} could not be inspected safely`);
  }
}

function identitiesEqual(left: ProjectPathIdentity, right: ProjectPathIdentity): boolean {
  if (left.normalized === right.normalized) return true;
  const leftEndpoint = left.existingPrefixes.at(-1);
  const rightEndpoint = right.existingPrefixes.at(-1);
  if (
    leftEndpoint === undefined ||
    rightEndpoint === undefined ||
    !samePhysical(leftEndpoint, rightEndpoint)
  ) {
    return false;
  }
  if (left.unresolvedComponents.length === 0 && right.unresolvedComponents.length === 0)
    return true;
  return normalizedComponentsEqual(left.unresolvedComponents, right.unresolvedComponents);
}

function identitiesOverlap(left: ProjectPathIdentity, right: ProjectPathIdentity): boolean {
  if (
    left.normalized === "." ||
    right.normalized === "." ||
    componentsStartWith(left.components, right.components) ||
    componentsStartWith(right.components, left.components)
  )
    return true;

  const leftEndpoint = left.existingPrefixes.at(-1);
  const rightEndpoint = right.existingPrefixes.at(-1);
  if (
    left.unresolvedComponents.length === 0 &&
    leftEndpoint !== undefined &&
    right.existingPrefixes.some((prefix) => samePhysical(leftEndpoint, prefix))
  )
    return true;
  if (
    right.unresolvedComponents.length === 0 &&
    rightEndpoint !== undefined &&
    left.existingPrefixes.some((prefix) => samePhysical(rightEndpoint, prefix))
  )
    return true;
  return (
    leftEndpoint !== undefined &&
    rightEndpoint !== undefined &&
    samePhysical(leftEndpoint, rightEndpoint) &&
    normalizedComponentPathsOverlap(left.unresolvedComponents, right.unresolvedComponents)
  );
}

function samePhysical(left: ExistingPrefixIdentity, right: ExistingPrefixIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function conservativeComponent(value: string): string {
  return value.normalize("NFD").toLocaleLowerCase("en-US");
}

function normalizedComponentsEqual(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (component, index) =>
        conservativeComponent(component) === conservativeComponent(right[index]!),
    )
  );
}

function normalizedComponentPathsOverlap(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const normalizedLeft = left.map(conservativeComponent);
  const normalizedRight = right.map(conservativeComponent);
  return (
    componentsStartWith(normalizedLeft, normalizedRight) ||
    componentsStartWith(normalizedRight, normalizedLeft)
  );
}

function componentsStartWith(value: readonly string[], prefix: readonly string[]): boolean {
  return (
    prefix.length <= value.length && prefix.every((component, index) => value[index] === component)
  );
}
