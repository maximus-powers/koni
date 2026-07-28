import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  assertRuntimeExecutableCurrent,
  resolveRuntimeExecutable,
  sameRuntimeExecutableIdentity,
  type RuntimeExecutableIdentity,
} from "../runtime/executable.js";

const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface GitRepositoryIdentity {
  worktreeRoot: string;
  commonDirectory: string;
}

export interface RecentBranch {
  name: string;
  oid: string;
  committedAtSeconds: number;
}

export interface GitBranchRef {
  ref: string;
  oid: string;
}

export interface GitCommandResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
  executableSha256: string;
}

export interface GitWorktreeEntry {
  path: string;
  head: string;
  branch: string | undefined;
  detached: boolean;
  locked: boolean;
  lockReason: string | undefined;
  prunable: boolean;
}

export interface GitStatusEntry {
  code: string;
  path: string;
  originalPath: string | undefined;
}

export interface GitTreeMergeResult {
  treeOid: string | undefined;
  conflictPaths: string[];
  messages: string;
}

export interface GitCommitIdentity {
  name: string;
  email: string;
  /** A Git-compatible timestamp, for example `2026-07-16T12:00:00Z`. */
  timestamp?: string;
}

interface GitRunOptions {
  stdin?: Uint8Array;
  acceptedExitCodes?: readonly number[];
  environment?: Readonly<Record<string, string>>;
}

export class GitCommandError extends Error {
  public readonly argv: readonly string[];
  public readonly exitCode: number | null;
  public readonly stderr: string;
  public readonly stdout: string;

  public constructor(
    argv: readonly string[],
    exitCode: number | null,
    stderr: string,
    stdout = "",
  ) {
    super(`git command failed (${exitCode ?? "signal"}): ${argv.join(" ")}`);
    this.name = "GitCommandError";
    this.argv = argv;
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.stdout = stdout;
  }
}

export class GitClient {
  readonly #root: string;
  readonly #executable: Promise<RuntimeExecutableIdentity>;

  public constructor(root: string, executable?: string) {
    this.#root = path.resolve(root);
    this.#executable =
      executable === undefined
        ? authorityGitExecutable()
        : resolveRuntimeExecutable("git", executable, process.env.PATH);
  }

  public static async discover(start: string, executable?: string): Promise<GitRepositoryIdentity> {
    const client = new GitClient(start, executable);
    const result = await client.#run([
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-common-dir",
    ]);
    const lines = result.stdout.toString("utf8").trimEnd().split("\n");
    if (lines.length !== 2 || lines.some((line) => line.length === 0)) {
      throw new GitCommandError(
        ["rev-parse", "--show-toplevel", "--git-common-dir"],
        0,
        "git returned an unexpected repository identity",
      );
    }
    const [worktreeRoot, commonDirectory] = await Promise.all([
      realpath(path.resolve(lines[0]!)),
      realpath(path.resolve(lines[1]!)),
    ]);
    return { worktreeRoot, commonDirectory };
  }

  public async version(): Promise<string> {
    const result = await this.#run(["--version"]);
    return result.stdout.toString("utf8").trim();
  }

  public async resolveRef(reference: string): Promise<string> {
    assertRef(reference);
    const result = await this.#run(["rev-parse", "--verify", `${reference}^{commit}`]);
    const oid = result.stdout.toString("ascii").trim();
    assertOid(oid);
    return oid;
  }

  public async tryResolveRef(reference: string): Promise<string | undefined> {
    assertRef(reference);
    const result = await this.#run(["rev-parse", "--verify", "--quiet", `${reference}^{commit}`], {
      acceptedExitCodes: [0, 1],
    });
    if (result.exitCode === 1) return undefined;
    const oid = result.stdout.toString("ascii").trim();
    assertOid(oid);
    return oid;
  }

  public async symbolicHead(): Promise<string | undefined> {
    const result = await this.#run(["symbolic-ref", "-q", "HEAD"], { acceptedExitCodes: [0, 1] });
    if (result.exitCode === 1) return undefined;
    const reference = result.stdout.toString("utf8").trim();
    assertRef(reference);
    return reference;
  }

  public async treeOfCommit(commitOid: string): Promise<string> {
    assertOid(commitOid);
    const result = await this.#run(["rev-parse", "--verify", `${commitOid}^{tree}`]);
    const oid = result.stdout.toString("ascii").trim();
    assertOid(oid);
    return oid;
  }

  public async statusPorcelain(): Promise<Buffer> {
    return (await this.#run(["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
  }

  public async statusEntries(): Promise<GitStatusEntry[]> {
    const output = (await this.#run(["status", "--porcelain=v1", "-z", "--untracked-files=all"]))
      .stdout;
    const records = splitNul(output);
    const entries: GitStatusEntry[] = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = decodeUtf8(records[index]!, "Git status path");
      if (record.length < 4 || record[2] !== " ") {
        throw new Error("git returned malformed porcelain status");
      }
      const code = record.slice(0, 2);
      const candidate = record.slice(3);
      if (candidate.length === 0) throw new Error("git returned an empty status path");
      let originalPath: string | undefined;
      if (code.includes("R") || code.includes("C")) {
        const original = records[index + 1];
        if (original === undefined) throw new Error("git omitted the original rename path");
        index += 1;
        originalPath = decodeUtf8(original, "Git rename path");
      }
      entries.push({ code, path: candidate, originalPath });
    }
    return entries.sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        (left.originalPath ?? "").localeCompare(right.originalPath ?? ""),
    );
  }

  public async changedPaths(): Promise<string[]> {
    const paths = new Set<string>();
    for (const entry of await this.statusEntries()) {
      paths.add(entry.path);
      if (entry.originalPath !== undefined) paths.add(entry.originalPath);
    }
    return [...paths].sort();
  }

  public async diffPaths(fromOid: string, toOid: string): Promise<string[]> {
    assertOid(fromOid);
    assertOid(toOid);
    const result = await this.#run([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--name-status",
      "--find-renames",
      "-z",
      fromOid,
      toOid,
      "--",
    ]);
    return parseNameStatus(result.stdout);
  }

  public async indexTree(): Promise<string> {
    const result = await this.#run(["write-tree"]);
    const oid = result.stdout.toString("ascii").trim();
    assertOid(oid);
    return oid;
  }

  public async worktreeMatchesIndex(): Promise<boolean> {
    const result = await this.#run(["diff-files", "--quiet", "--no-ext-diff", "--"], {
      acceptedExitCodes: [0, 1],
    });
    return result.exitCode === 0;
  }

  public async untrackedPaths(): Promise<string[]> {
    const output = (await this.#run(["ls-files", "--others", "--exclude-standard", "-z", "--"]))
      .stdout;
    return splitNul(output)
      .map((entry) => decodeUtf8(entry, "untracked Git path"))
      .sort();
  }

  public async assertNoFilteredPaths(paths: readonly string[]): Promise<void> {
    if (paths.length === 0) return;
    for (const candidate of paths) assertPathspec(candidate);
    const result = await this.#run(["check-attr", "-z", "filter", "--", ...paths]);
    const fields = splitNul(result.stdout).map((entry) => decodeUtf8(entry, "Git attribute"));
    if (fields.length % 3 !== 0) throw new Error("git returned malformed filter attributes");
    const filtered: string[] = [];
    for (let index = 0; index < fields.length; index += 3) {
      const candidate = fields[index]!;
      const attribute = fields[index + 1]!;
      const value = fields[index + 2]!;
      if (attribute !== "filter") throw new Error("git returned an unexpected attribute");
      if (value !== "unspecified" && value !== "unset") filtered.push(`${candidate} (${value})`);
    }
    if (filtered.length > 0) {
      throw new Error(
        `refusing to checkpoint paths with Git content filters: ${filtered.join(", ")}`,
      );
    }
  }

  public async stageAll(): Promise<void> {
    await this.#run(["add", "--all", "--", "."]);
  }

  public async resetHard(commitOid: string): Promise<void> {
    assertOid(commitOid);
    await this.#run(["reset", "--hard", commitOid]);
  }

  public async recentBranches(limit = 20): Promise<RecentBranch[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("branch limit must be between 1 and 1000");
    }
    const result = await this.#run([
      "for-each-ref",
      `--count=${limit}`,
      "--sort=-committerdate",
      "--format=%(refname:short)%00%(objectname)%00%(committerdate:unix)",
      "refs/heads",
    ]);
    const branches: RecentBranch[] = [];
    for (const record of result.stdout.toString("utf8").split("\n")) {
      if (record.length === 0) {
        continue;
      }
      const [name, oid, timestamp, ...extra] = record.split("\0");
      if (
        name === undefined ||
        oid === undefined ||
        timestamp === undefined ||
        extra.length !== 0
      ) {
        throw new Error("git returned a malformed branch record");
      }
      assertRef(name);
      if (name === "koni" || name.startsWith("koni/")) continue;
      assertOid(oid);
      const committedAtSeconds = Number(timestamp);
      if (!Number.isSafeInteger(committedAtSeconds) || committedAtSeconds < 0) {
        throw new Error("git returned an invalid branch timestamp");
      }
      branches.push({ name, oid, committedAtSeconds });
    }
    return branches;
  }

  /** Exact local branch inventory used for pre-effect namespace-collision checks. */
  public async branchRefs(): Promise<GitBranchRef[]> {
    const result = await this.#run([
      "for-each-ref",
      "--format=%(refname)%00%(objectname)",
      "refs/heads",
    ]);
    const refs: GitBranchRef[] = [];
    for (const record of result.stdout.toString("utf8").split("\n")) {
      if (record.length === 0) continue;
      const [ref, oid, ...extra] = record.split("\0");
      if (ref === undefined || oid === undefined || extra.length !== 0) {
        throw new Error("git returned a malformed local branch record");
      }
      assertRef(ref);
      if (!ref.startsWith("refs/heads/")) throw new Error("git returned a non-branch ref");
      assertOid(oid);
      refs.push({ ref, oid });
    }
    return refs.sort((left, right) => left.ref.localeCompare(right.ref));
  }

  public async createWorktree(
    worktreePath: string,
    branch: string,
    startOid: string,
  ): Promise<void> {
    assertRef(branch);
    assertOid(startOid);
    const destination = path.resolve(worktreePath);
    await this.#run(["worktree", "add", "--no-track", "-b", branch, destination, startOid]);
  }

  public async createDetachedWorktree(
    worktreePath: string,
    startOid: string,
    lockReason: string,
  ): Promise<void> {
    assertOid(startOid);
    assertLockReason(lockReason);
    await this.#run([
      "worktree",
      "add",
      "--detach",
      "--lock",
      "--reason",
      lockReason,
      path.resolve(worktreePath),
      startOid,
    ]);
  }

  public async addExistingBranchWorktree(
    worktreePath: string,
    branch: string,
    lockReason?: string,
  ): Promise<void> {
    assertRef(branch);
    const argv = ["worktree", "add"];
    if (lockReason !== undefined) {
      assertLockReason(lockReason);
      argv.push("--lock", "--reason", lockReason);
    }
    const branchArgument = branch.startsWith("refs/heads/")
      ? branch.slice("refs/heads/".length)
      : branch;
    argv.push(path.resolve(worktreePath), branchArgument);
    await this.#run(argv);
  }

  public async removeWorktree(worktreePath: string): Promise<void> {
    await this.#run(["worktree", "remove", path.resolve(worktreePath)]);
  }

  /** Move one registered worktree without changing its branch, HEAD, or index. */
  public async moveWorktree(sourcePath: string, destinationPath: string): Promise<void> {
    const source = path.resolve(sourcePath);
    const destination = path.resolve(destinationPath);
    if (source === destination) return;
    await this.#run(["worktree", "move", source, destination]);
  }

  public async lockWorktree(worktreePath: string, lockReason: string): Promise<void> {
    assertLockReason(lockReason);
    await this.#run(["worktree", "lock", "--reason", lockReason, path.resolve(worktreePath)]);
  }

  public async unlockWorktree(worktreePath: string): Promise<void> {
    const result = await this.#run(["worktree", "unlock", path.resolve(worktreePath)], {
      acceptedExitCodes: [0, 128],
    });
    if (result.exitCode !== 0) {
      const message = result.stderr.toString("utf8");
      if (!message.includes("not locked")) {
        throw new GitCommandError(
          ["worktree", "unlock", path.resolve(worktreePath)],
          result.exitCode,
          message,
          result.stdout.toString("utf8"),
        );
      }
    }
  }

  public async worktrees(): Promise<GitWorktreeEntry[]> {
    const result = await this.#run(["worktree", "list", "--porcelain", "-z"]);
    return parseWorktrees(result.stdout);
  }

  public async createRef(reference: string, newOid: string): Promise<void> {
    assertRef(reference);
    assertOid(newOid);
    await this.#run(["update-ref", reference, newOid, zeroOid(newOid.length)]);
  }

  public async deleteRef(reference: string, expectedOldOid: string): Promise<void> {
    assertRef(reference);
    assertOid(expectedOldOid);
    await this.#run(["update-ref", "-d", reference, expectedOldOid]);
  }

  public async updateRef(reference: string, newOid: string, expectedOldOid: string): Promise<void> {
    assertRef(reference);
    assertOid(newOid);
    assertOid(expectedOldOid);
    await this.#run(["update-ref", reference, newOid, expectedOldOid]);
  }

  public async isAncestor(ancestorOid: string, descendantOid: string): Promise<boolean> {
    assertOid(ancestorOid);
    assertOid(descendantOid);
    if (ancestorOid === descendantOid) return true;
    const result = await this.#run(["merge-base", "--is-ancestor", ancestorOid, descendantOid], {
      acceptedExitCodes: [0, 1],
    });
    return result.exitCode === 0;
  }

  public async mergeBase(leftOid: string, rightOid: string): Promise<string> {
    assertOid(leftOid);
    assertOid(rightOid);
    const result = await this.#run(["merge-base", leftOid, rightOid]);
    const oid = result.stdout.toString("ascii").trim();
    assertOid(oid);
    return oid;
  }

  public async commitTree(
    treeOid: string,
    parents: readonly string[],
    message: string,
    identity?: GitCommitIdentity,
  ): Promise<string> {
    assertOid(treeOid);
    if (message.length === 0 || message.length > 64 * 1024 || message.includes("\0")) {
      throw new Error("commit message is empty or too large");
    }
    const argv = ["commit-tree", treeOid];
    for (const parent of parents) {
      assertOid(parent);
      argv.push("-p", parent);
    }
    const environment: Record<string, string> = {};
    if (identity !== undefined) {
      assertIdentity(identity);
      environment.GIT_AUTHOR_NAME = identity.name;
      environment.GIT_AUTHOR_EMAIL = identity.email;
      environment.GIT_COMMITTER_NAME = identity.name;
      environment.GIT_COMMITTER_EMAIL = identity.email;
      if (identity.timestamp !== undefined) {
        environment.GIT_AUTHOR_DATE = identity.timestamp;
        environment.GIT_COMMITTER_DATE = identity.timestamp;
      }
    }
    const result = await this.#run(argv, {
      stdin: Buffer.from(message, "utf8"),
      environment,
    });
    const oid = result.stdout.toString("ascii").trim();
    assertOid(oid);
    return oid;
  }

  public async mergeTree(
    ours: string,
    theirs: string,
  ): Promise<{ tree?: string; conflicts: string }> {
    assertOid(ours);
    assertOid(theirs);
    try {
      const result = await this.#run(["merge-tree", "--write-tree", "--messages", ours, theirs]);
      const output = result.stdout.toString("utf8");
      const [first, ...rest] = output.split("\n");
      if (first === undefined) {
        throw new Error("git merge-tree returned no tree");
      }
      const tree = first.trim();
      assertOid(tree);
      return { tree, conflicts: rest.join("\n").trim() };
    } catch (error) {
      if (!(error instanceof GitCommandError)) {
        throw error;
      }
      const output = error.stdout;
      const [first, ...rest] = output.split("\n");
      const possibleTree = first?.trim();
      const messages = [...rest, error.stderr].join("\n").trim();
      if (possibleTree !== undefined && /^[0-9a-f]{40,64}$/u.test(possibleTree)) {
        return { tree: possibleTree, conflicts: messages || "Git reported merge conflicts" };
      }
      return { conflicts: messages || "Git could not compute a merge tree" };
    }
  }

  public async mergeTreeDetailed(ours: string, theirs: string): Promise<GitTreeMergeResult> {
    assertOid(ours);
    assertOid(theirs);
    const result = await this.#run(
      ["merge-tree", "--write-tree", "--no-messages", "--name-only", "-z", ours, theirs],
      { acceptedExitCodes: [0, 1] },
    );
    const fields = splitNul(result.stdout).map((entry) => decodeUtf8(entry, "merge-tree output"));
    const treeOid = fields.shift();
    if (treeOid !== undefined) assertOid(treeOid);
    if (result.exitCode === 0) {
      if (fields.length !== 0) throw new Error("git reported paths for a conflict-free merge tree");
      return { treeOid, conflictPaths: [], messages: "" };
    }
    return {
      treeOid,
      conflictPaths: [...new Set(fields)].sort(),
      messages: "Git reported a tree composition conflict",
    };
  }

  async #run(argv: readonly string[], options: GitRunOptions = {}): Promise<GitCommandResult> {
    if (argv.length === 0 || argv.some((argument) => argument.includes("\0"))) {
      throw new Error("git argv is empty or contains NUL");
    }
    const complete = [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "credential.helper=",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "diff.external=",
      "-C",
      this.#root,
      ...argv,
    ];
    const executable = await this.#executable;
    await assertRuntimeExecutableCurrent(executable);
    return new Promise((resolve, reject) => {
      const child = spawn(executable.path, complete, {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          GIT_ALLOW_PROTOCOL: "file",
          GIT_EXTERNAL_DIFF: "",
          GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=5",
          ...options.environment,
        },
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let observed = 0;
      let overflow = false;
      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        observed += chunk.byteLength;
        if (observed > MAX_GIT_OUTPUT_BYTES) {
          overflow = true;
          child.kill("SIGKILL");
          return;
        }
        target.push(Buffer.from(chunk));
      };
      child.stdout.on("data", collect(stdout));
      child.stderr.on("data", collect(stderr));
      child.once("error", reject);
      child.once("close", (code) => {
        if (overflow) {
          reject(new GitCommandError(argv, code, "git output exceeded its bounded capture"));
          return;
        }
        if (code === null) {
          reject(new GitCommandError(argv, null, "git process terminated by signal"));
          return;
        }
        const result = {
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
          exitCode: code,
          executableSha256: executable.sha256,
        };
        if (!(options.acceptedExitCodes ?? [0]).includes(code)) {
          reject(
            new GitCommandError(
              argv,
              code,
              result.stderr.toString("utf8"),
              result.stdout.toString("utf8"),
            ),
          );
          return;
        }
        resolve(result);
      });
      if (options.stdin === undefined) {
        child.stdin.end();
      } else {
        child.stdin.end(options.stdin);
      }
    });
  }
}

const initialGitPath = process.env.PATH;
let pinnedGitExecutable: Promise<RuntimeExecutableIdentity> | undefined;

/**
 * Bind every subsequently constructed authority Git client to the executable authenticated in the
 * complete runtime closure. Production runs one authority per process, so a second, different pin
 * is always an integrity failure rather than a supported reconfiguration.
 */
export async function pinAuthorityGitExecutable(
  executable: RuntimeExecutableIdentity,
): Promise<void> {
  if (executable.role !== "git") {
    throw new Error("authority Git executable pin has the wrong role");
  }
  await assertRuntimeExecutableCurrent(executable);
  if (pinnedGitExecutable !== undefined) {
    const current = await pinnedGitExecutable;
    if (!sameRuntimeExecutableIdentity(current, executable)) {
      throw new Error("authority Git executable was already pinned to different bytes");
    }
    return;
  }
  pinnedGitExecutable = Promise.resolve(structuredClone(executable));
}

function authorityGitExecutable(): Promise<RuntimeExecutableIdentity> {
  pinnedGitExecutable ??= resolveRuntimeExecutable("git", "git", initialGitPath);
  return pinnedGitExecutable;
}

function splitNul(value: Buffer): Buffer[] {
  const fields: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== 0) continue;
    if (index > start) fields.push(value.subarray(start, index));
    else fields.push(Buffer.alloc(0));
    start = index + 1;
  }
  if (start !== value.length) throw new Error("git returned output without a final NUL separator");
  while (fields.at(-1)?.byteLength === 0) fields.pop();
  return fields;
}

function decodeUtf8(value: Buffer, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function parseNameStatus(output: Buffer): string[] {
  const fields = splitNul(output).map((field) => decodeUtf8(field, "Git diff path"));
  const paths = new Set<string>();
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    const candidate = fields[index++];
    if (status === undefined || candidate === undefined || !/^[A-Z][0-9]*$/u.test(status)) {
      throw new Error("git returned malformed name-status output");
    }
    paths.add(candidate);
    if (status.startsWith("R") || status.startsWith("C")) {
      const destination = fields[index++];
      if (destination === undefined) throw new Error("git omitted a renamed destination path");
      paths.add(destination);
    }
  }
  return [...paths].sort();
}

function parseWorktrees(output: Buffer): GitWorktreeEntry[] {
  const fields = splitNul(output).map((field) => decodeUtf8(field, "Git worktree record"));
  const entries: GitWorktreeEntry[] = [];
  let current: Partial<GitWorktreeEntry> | undefined;
  const finish = () => {
    if (current === undefined) return;
    if (current.path === undefined || current.head === undefined) {
      throw new Error("git returned an incomplete worktree record");
    }
    assertOid(current.head);
    entries.push({
      path: path.resolve(current.path),
      head: current.head,
      branch: current.branch,
      detached: current.detached ?? false,
      locked: current.locked ?? false,
      lockReason: current.lockReason,
      prunable: current.prunable ?? false,
    });
  };
  for (const field of fields) {
    if (field === "") {
      finish();
      current = undefined;
    } else if (field.startsWith("worktree ")) {
      finish();
      current = { path: field.slice("worktree ".length) };
    } else if (current === undefined) {
      throw new Error("git worktree output did not begin with a worktree path");
    } else if (field.startsWith("HEAD ")) {
      current.head = field.slice("HEAD ".length);
    } else if (field.startsWith("branch ")) {
      current.branch = field.slice("branch ".length);
    } else if (field === "detached") {
      current.detached = true;
    } else if (field === "locked" || field.startsWith("locked ")) {
      current.locked = true;
      current.lockReason = field === "locked" ? undefined : field.slice("locked ".length);
    } else if (field === "prunable" || field.startsWith("prunable ")) {
      current.prunable = true;
    } else if (field !== "bare") {
      throw new Error(`git returned an unknown worktree field: ${field}`);
    }
  }
  finish();
  return entries;
}

function assertPathspec(value: string): void {
  if (
    value.length === 0 ||
    value.length > 16 * 1024 ||
    value.includes("\0") ||
    value.startsWith("-") ||
    path.isAbsolute(value)
  ) {
    throw new Error(`unsafe Git pathspec: ${value}`);
  }
}

function assertLockReason(value: string): void {
  if (value.length === 0 || value.length > 1_024 || value.includes("\0") || value.includes("\n")) {
    throw new Error("Git worktree lock reason is empty, too large, or malformed");
  }
}

function assertIdentity(identity: GitCommitIdentity): void {
  for (const [label, value] of [
    ["name", identity.name],
    ["email", identity.email],
  ] as const) {
    if (value.length === 0 || value.length > 1_024 || /[\0\r\n<>]/u.test(value)) {
      throw new Error(`Git commit identity ${label} is malformed`);
    }
  }
  if (identity.timestamp !== undefined && /[\0\r\n]/u.test(identity.timestamp)) {
    throw new Error("Git commit identity timestamp is malformed");
  }
}

function zeroOid(length: number): string {
  if (length !== 40 && length !== 64) throw new Error("unsupported Git object id length");
  return "0".repeat(length);
}

function assertOid(value: string): void {
  if (!/^[0-9a-f]{40,64}$/u.test(value)) {
    throw new Error(`invalid Git object id: ${value}`);
  }
}

function assertRef(value: string): void {
  if (
    value.length === 0 ||
    value.length > 1_024 ||
    value.startsWith("-") ||
    value.includes("\0") ||
    /[\u0000-\u0020~^:?*\\[\]]/u.test(value)
  ) {
    throw new Error(`unsafe Git reference: ${value}`);
  }
}
