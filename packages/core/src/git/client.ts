import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";

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

export interface GitCommandResult {
  stdout: Buffer;
  stderr: Buffer;
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
  readonly #executable: string;

  public constructor(root: string, executable = "git") {
    this.#root = path.resolve(root);
    this.#executable = executable;
  }

  public static async discover(start: string, executable = "git"): Promise<GitRepositoryIdentity> {
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
      assertOid(oid);
      const committedAtSeconds = Number(timestamp);
      if (!Number.isSafeInteger(committedAtSeconds) || committedAtSeconds < 0) {
        throw new Error("git returned an invalid branch timestamp");
      }
      branches.push({ name, oid, committedAtSeconds });
    }
    return branches;
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

  public async removeWorktree(worktreePath: string): Promise<void> {
    await this.#run(["worktree", "remove", path.resolve(worktreePath)]);
  }

  public async updateRef(reference: string, newOid: string, expectedOldOid: string): Promise<void> {
    assertRef(reference);
    assertOid(newOid);
    assertOid(expectedOldOid);
    await this.#run(["update-ref", reference, newOid, expectedOldOid]);
  }

  public async commitTree(
    treeOid: string,
    parents: readonly string[],
    message: string,
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
    const result = await this.#run(argv, Buffer.from(message, "utf8"));
    const oid = result.stdout.toString("ascii").trim();
    assertOid(oid);
    return oid;
  }

  public async mergeTree(ours: string, theirs: string): Promise<{ tree?: string; conflicts: string }> {
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

  async #run(argv: readonly string[], stdin?: Uint8Array): Promise<GitCommandResult> {
    if (argv.length === 0 || argv.some((argument) => argument.includes("\0"))) {
      throw new Error("git argv is empty or contains NUL");
    }
    const complete = [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "credential.helper=",
      "-C",
      this.#root,
      ...argv,
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(this.#executable, complete, {
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
          GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=5",
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
        const result = { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
        if (code !== 0) {
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
      if (stdin === undefined) {
        child.stdin.end();
      } else {
        child.stdin.end(stdin);
      }
    });
  }
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
