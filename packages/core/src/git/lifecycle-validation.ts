export function assertCommitSubject(value: string): void {
  if (value.trim().length === 0 || value.length > 8 * 1024 || /[\0\r\n]/u.test(value)) {
    throw new Error("commit subject must be one bounded non-empty line");
  }
}

export function assertNamespaceId(value: string, label: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(value) ||
    value.includes("..") ||
    value.endsWith(".") ||
    value.endsWith(".lock")
  ) {
    throw new Error(`${label} is not safe for a compiler-owned Git namespace: ${value}`);
  }
}

export function shortTargetBranch(ref: string): string {
  return ref.replace(/^refs\/heads\//u, "");
}

export function assertUserTargetRef(value: string): void {
  if (
    !value.startsWith("refs/heads/") ||
    value.length > 1_024 ||
    /[\u0000-\u0020~^:?*\\[\]]/u.test(value)
  ) {
    throw new Error(`target must be a safe local branch ref: ${value}`);
  }
  const branch = value.slice("refs/heads/".length);
  if (
    branch.includes("..") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch
      .split("/")
      .some(
        (component) => component.length === 0 || component === "." || component.endsWith(".lock"),
      )
  ) {
    throw new Error(`target branch ref is malformed: ${value}`);
  }
  if (branch === "koni" || branch.startsWith("koni/")) {
    throw new Error(`compiler-owned branch cannot be selected as a target: ${value}`);
  }
}
