#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KONI_CORE_API_VERSION } from "./contracts/profile-package.js";
import { discoverAuthorityEndpoint } from "./authority/endpoint.js";
import { GitClient } from "./git/client.js";
import { runStandaloneControlCenter } from "./control-center/standalone.js";
import { parseControlCatalog } from "./control-center/protocol.js";
import { connectRunningKoniAuthority } from "./pi/interactive-tools.js";
import { parseMonitorSnapshot, type MonitorRunSummary } from "./monitor/protocol.js";
import {
  createProjectRun,
  ensureProjectAuthority,
  inspectProjectAuthority,
  approveProjectRun,
  resumeProjectRun,
  serveProjectAuthority,
  stopProjectAuthority,
  validateProjectConfiguration,
} from "./operator/authority-bootstrap.js";
import {
  installAndCacheProfile,
  previewProfileUpdate,
  readInstalledProfileReference,
  resolveProfilePackageRoot,
} from "./operator/profile-source.js";
import { isSha256Digest, type Sha256Digest } from "./shared/canonical.js";

export interface KoniCliIO {
  stdout(text: string): void;
  stderr(text: string): void;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
}

export interface KoniCliDependencies {
  ensure: typeof ensureProjectAuthority;
  inspect: typeof inspectProjectAuthority;
  serve: typeof serveProjectAuthority;
  stop: typeof stopProjectAuthority;
  validate: typeof validateProjectConfiguration;
  install: typeof installAndCacheProfile;
  previewInstall: typeof previewProfileUpdate;
  resolveProfile: typeof resolveProfilePackageRoot;
  readInstalled: typeof readInstalledProfileReference;
  run: typeof createProjectRun;
  resumeRun: typeof resumeProjectRun;
  approveRun: typeof approveProjectRun;
  standalone: typeof runStandaloneControlCenter;
  connectReadOnly: typeof connectRunningKoniAuthority;
}

const DEFAULT_IO: KoniCliIO = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  stdinIsTTY: process.stdin.isTTY === true,
  stdoutIsTTY: process.stdout.isTTY === true,
};

const DEFAULT_DEPENDENCIES: KoniCliDependencies = {
  ensure: ensureProjectAuthority,
  inspect: inspectProjectAuthority,
  serve: serveProjectAuthority,
  stop: stopProjectAuthority,
  validate: validateProjectConfiguration,
  install: installAndCacheProfile,
  previewInstall: previewProfileUpdate,
  resolveProfile: resolveProfilePackageRoot,
  readInstalled: readInstalledProfileReference,
  run: createProjectRun,
  resumeRun: resumeProjectRun,
  approveRun: approveProjectRun,
  standalone: runStandaloneControlCenter,
  connectReadOnly: connectRunningKoniAuthority,
};

export async function runKoniCli(
  argv: readonly string[],
  io: KoniCliIO = DEFAULT_IO,
  dependencies: KoniCliDependencies = DEFAULT_DEPENDENCIES,
): Promise<number> {
  const parsed = parseCli(argv);
  if (parsed.version) {
    io.stdout(`${KONI_CORE_API_VERSION}\n`);
    return 0;
  }
  if (parsed.help || parsed.command === undefined) {
    io.stdout(helpText());
    return 0;
  }
  const projectRoot = path.resolve(parsed.root ?? process.cwd());
  switch (parsed.command) {
    case "init": {
      const endpoint = await discoverAuthorityEndpoint(projectRoot);
      const selector = parsed.profilePackage ?? parsed.positionals[0] ?? "coding";
      const packageRoot = await dependencies.resolveProfile(selector);
      const result = await dependencies.install({
        projectRoot: endpoint.identity.worktreeRoot,
        profilePackageRoot: packageRoot,
      });
      print(io, parsed.json, result, [
        `Installed ${result.packageName}@${result.profileVersion}`,
        `Project: ${result.projectConfigRoot}`,
        `Added ${result.added.length}, updated ${result.updated.length}, preserved ${result.preserved.length}`,
        ...(result.pendingUpstream.length === 0
          ? []
          : [`${result.pendingUpstream.length} upstream change(s) staged for review`]),
      ]);
      return 0;
    }
    case "update": {
      const endpoint = await discoverAuthorityEndpoint(projectRoot);
      const installed = await dependencies.readInstalled(endpoint.identity.worktreeRoot);
      const selector = parsed.profilePackage ?? parsed.positionals[0] ?? installed.packageName;
      const packageRoot = await dependencies.resolveProfile(selector);
      const preview = await dependencies.previewInstall({
        projectRoot: endpoint.identity.worktreeRoot,
        profilePackageRoot: packageRoot,
      });
      if (preview.mandatoryRetirements.length > 0 && !parsed.apply) {
        print(io, parsed.json, preview, [
          `Update ${installed.profileVersion} → ${preview.profileVersion} retires configured semantics.`,
          ...preview.mandatoryRetirements.flatMap((retirement) => [
            `Retirement: ${retirement.id}`,
            ...retirement.operations.map(
              (operation) =>
                `  ${operation.file}${operation.pointer}: ${operation.project.present ? JSON.stringify(operation.project.value) : "already absent"}`,
            ),
          ]),
          `Preview: ${preview.previewSha256}`,
          "No project files were changed. Apply this exact preview with:",
          `  koni update ${selector} --preview ${preview.previewSha256} --apply`,
        ]);
        return 0;
      }
      if (preview.mandatoryRetirements.length > 0 && parsed.previewSha256 === undefined) {
        throw new CliUsageError(
          "update --apply requires --preview <sha256> from the semantic-retirement preview",
        );
      }
      const result = await dependencies.install({
        projectRoot: endpoint.identity.worktreeRoot,
        profilePackageRoot: packageRoot,
        ...(parsed.previewSha256 === undefined
          ? {}
          : { expectedPreviewSha256: parseSha256(parsed.previewSha256, "--preview") }),
      });
      // A live authority pins the Core build and configuration it started with, so an update is
      // invisible until it restarts. Keeping the authority an invisible background process, stop
      // any running one here; the next `/koni`, `koni tui`, or run transparently starts it fresh
      // on the updated configuration. Stopping quiesces active runs rather than dropping them.
      const authority = await dependencies.stop({
        projectRoot: endpoint.identity.worktreeRoot,
        version: KONI_CORE_API_VERSION,
      });
      print(io, parsed.json, { ...result, authority }, [
        `Updated ${result.packageName}@${result.profileVersion}`,
        `Updated ${result.updated.length}, added ${result.added.length}, preserved ${result.preserved.length}`,
        ...(authority.wasRunning
          ? [
              authority.pausedRunCount === 0
                ? "Stopped the running authority so the update takes effect; it restarts automatically on next use."
                : `Stopped the running authority and paused ${authority.pausedRunCount} active run(s) so the update takes effect; it restarts automatically on next use.`,
            ]
          : []),
        ...(result.pendingUpstream.length === 0
          ? []
          : [
              `${result.pendingUpstream.length} upstream change(s) need review.`,
              "Run `koni conflicts` or open Configure → Upstream changes.",
            ]),
      ]);
      return 0;
    }
    case "conflicts": {
      const client = await dependencies.ensure({
        projectRoot,
        version: KONI_CORE_API_VERSION,
        client: "cli",
      });
      try {
        const selectedPath = parsed.positionals[0];
        if (selectedPath === undefined) {
          const response = await client.request("profile.conflicts.list");
          const result = conflictCatalog(response.result);
          print(
            io,
            parsed.json,
            result,
            result.conflicts.length === 0
              ? ["No upstream profile changes need review."]
              : [
                  `${result.conflicts.length} upstream profile change(s) need review:`,
                  ...result.conflicts.map((conflict) => `  ${conflict.path} · ${conflict.reason}`),
                  "Inspect one with `koni conflicts <path>`.",
                ],
          );
          return 0;
        }
        const inspected = conflictInspection(
          (
            await client.request("profile.conflicts.inspect", {
              path: selectedPath,
            })
          ).result,
        );
        if (parsed.conflictResolution === undefined) {
          print(io, parsed.json, inspected, [
            `${inspected.conflict.title} · ${inspected.conflict.reason}`,
            `Path: ${inspected.conflict.path}`,
            "",
            "Project version:",
            inspected.currentText ?? "(deleted)",
            "",
            "Upstream version:",
            inspected.upstreamText ?? "(deleted upstream)",
            "",
            `Resolve with --keep-project or --accept-upstream: koni conflicts ${selectedPath} --keep-project`,
          ]);
          return 0;
        }
        const response = await client.request(
          "profile.conflicts.resolve",
          {
            path: inspected.conflict.path,
            expectedLifecycleGeneration: inspected.lifecycleGeneration,
            expectedProjectSha256: inspected.conflict.currentSha256,
            resolution: parsed.conflictResolution,
          },
          {
            expectedRevision: client.revision,
            idempotencyKey: `profile.conflicts.resolve:${randomUUID()}`,
          },
        );
        print(io, parsed.json, response.result ?? {}, [
          `${parsed.conflictResolution === "keep_project" ? "Kept project version of" : "Accepted upstream version of"} ${selectedPath}.`,
        ]);
        return 0;
      } finally {
        client.close();
      }
    }
    case "start": {
      const client = await dependencies.ensure({
        projectRoot,
        version: KONI_CORE_API_VERSION,
        client: "cli",
      });
      const response = await client.request("project.status");
      client.close();
      print(io, parsed.json, response.result ?? {}, ["Koni authority is running."]);
      return 0;
    }
    case "stop": {
      const result = await dependencies.stop({
        projectRoot,
        version: KONI_CORE_API_VERSION,
      });
      print(io, parsed.json, result, [
        result.wasRunning ? "Koni authority stopped." : "Koni authority was already stopped.",
        ...(result.pausedRunCount === 0
          ? []
          : [`Paused ${result.pausedRunCount} active run(s) before shutdown.`]),
      ]);
      return 0;
    }
    case "restart": {
      const stopped = await dependencies.stop({
        projectRoot,
        version: KONI_CORE_API_VERSION,
      });
      const client = await dependencies.ensure({
        projectRoot,
        version: KONI_CORE_API_VERSION,
        client: "cli",
      });
      const response = await client.request("project.status");
      client.close();
      print(io, parsed.json, { stopped, authority: response.result ?? {} }, [
        "Koni authority restarted on the current Core build.",
        ...(stopped.pausedRunCount === 0
          ? []
          : [`${stopped.pausedRunCount} run(s) remain paused; resume them explicitly when ready.`]),
      ]);
      return 0;
    }
    case "status": {
      const status = await dependencies.inspect({ projectRoot, version: KONI_CORE_API_VERSION });
      let runs: readonly MonitorRunSummary[] = [];
      if (status.running && (status.authority?.runCount ?? 0) > 0) {
        const client = await dependencies.connectReadOnly({
          projectRoot,
          version: KONI_CORE_API_VERSION,
        });
        if (client !== undefined) {
          try {
            const response = await client.request("monitor.snapshot", { limit: 50 });
            runs = parseMonitorSnapshot(response.result).runs;
          } finally {
            client.close();
          }
        }
      }
      print(io, parsed.json, { ...status, runs }, [
        `Authority: ${status.running ? "running" : "stopped"}`,
        `Project: ${status.projectRoot}`,
        `Git common dir: ${status.commonDirectory}`,
        `Profile: ${
          status.profile === undefined
            ? "not installed"
            : `${status.profile.packageName}@${status.profile.profileVersion}`
        }`,
        ...(status.authority === undefined
          ? []
          : [`Revision: ${status.authority.revision}`, `Runs: ${status.authority.runCount}`]),
        ...runs.flatMap((run) => [
          `  ${run.id} · ${run.runType} · ${runStatusLine(run)}`,
          ...(run.blocker === undefined ? [] : [`    blocked: ${run.blocker}`]),
          ...(run.failure === undefined ? [] : [`    failed: ${run.failure}`]),
        ]),
      ]);
      return status.profile === undefined ? 2 : 0;
    }
    case "config": {
      const action = parsed.positionals[0] ?? "validate";
      if (action !== "validate" && action !== "status") {
        throw new CliUsageError(`unknown config action: ${action}`);
      }
      const status = await dependencies.validate(projectRoot);
      print(
        io,
        parsed.json,
        status,
        status.ok && status.configuration !== undefined
          ? [
              `Valid ${status.profile.packageName}@${status.profile.profileVersion} configuration`,
              `Run types: ${status.configuration.runTypes.join(", ")}`,
              `Agents: ${status.configuration.agents.join(", ")}`,
              `Configuration: ${status.configuration.sha256}`,
            ]
          : [
              "Configuration is invalid:",
              ...status.diagnostics.map(
                (diagnostic) => `  ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`,
              ),
            ],
      );
      return status.ok ? 0 : 2;
    }
    case "tui": {
      if (!io.stdinIsTTY || !io.stdoutIsTTY) {
        throw new CliUsageError("koni tui requires an interactive terminal");
      }
      const client = await dependencies.ensure({
        projectRoot,
        version: KONI_CORE_API_VERSION,
        client: "tui",
      });
      try {
        const endpoint = await discoverAuthorityEndpoint(projectRoot);
        await dependencies.standalone({
          projectRoot: endpoint.identity.worktreeRoot,
          version: KONI_CORE_API_VERSION,
          client,
          reconnectClient: () =>
            dependencies.ensure({
              projectRoot: endpoint.identity.worktreeRoot,
              version: KONI_CORE_API_VERSION,
              client: "tui",
            }),
        });
      } finally {
        client.close();
      }
      return 0;
    }
    case "run": {
      const objective = parsed.goal ?? parsed.positionals.join(" ").trim();
      if (objective.length === 0) throw new CliUsageError("run requires --goal <text>");
      let runTypeId = parsed.runType;
      if (runTypeId === undefined) {
        const client = await dependencies.ensure({
          projectRoot,
          version: KONI_CORE_API_VERSION,
          client: "cli",
        });
        try {
          const catalog = parseControlCatalog((await client.request("control.catalog")).result);
          runTypeId = catalog.defaultRunTypeId;
        } finally {
          client.close();
        }
      }
      // `--from <ref>` implies branching a new target; either flag opts into provisioning.
      const createTarget = parsed.newTarget || parsed.from !== undefined;
      if (createTarget && parsed.target === undefined) {
        throw new CliUsageError(
          "--new-target requires --target <branch> to name the branch to create",
        );
      }
      const targetRef = parsed.target ?? (await defaultTargetBranch(projectRoot));
      const result = await dependencies.run({
        projectRoot,
        version: KONI_CORE_API_VERSION,
        objective,
        runTypeId,
        targetRef,
        // Run types may declare required intake beyond the objective; without this the CLI
        // cannot start them at all and the TUI is the only way in.
        ...(parsed.fields === undefined ? {} : { intake: { goal: objective, ...parsed.fields } }),
        ...(createTarget ? { createTarget: true } : {}),
        ...(parsed.from === undefined ? {} : { baseRef: parsed.from }),
      });
      const onto = createTarget
        ? ` on new branch ${targetRef}${parsed.from === undefined ? "" : ` from ${parsed.from}`}`
        : ` on ${targetRef}`;
      print(io, parsed.json, result, [
        `Started ${runTypeId} run ${result.runId}${onto}.`,
        ...(result.modelNotice === undefined ? [] : [result.modelNotice]),
      ]);
      return 0;
    }
    case "resume": {
      const runId = parsed.runId ?? parsed.positionals[0];
      if (runId === undefined) throw new CliUsageError("resume requires --run <run-id>");
      const result = await dependencies.resumeRun({
        projectRoot,
        version: KONI_CORE_API_VERSION,
        runId,
      });
      print(io, parsed.json, result, [`Resumed run ${result.runId} into ${result.status}.`]);
      return 0;
    }
    case "approve": {
      const runId = parsed.runId ?? parsed.positionals[0];
      if (runId === undefined) throw new CliUsageError("approve requires --run <run-id>");
      const result = await dependencies.approveRun({
        projectRoot,
        version: KONI_CORE_API_VERSION,
        runId,
      });
      print(io, parsed.json, result, [`Approved run ${result.runId} into ${result.status}.`]);
      return 0;
    }
    case "authority": {
      if (parsed.positionals[0] !== "serve") {
        throw new CliUsageError("authority is an internal command; expected `authority serve`");
      }
      const providerFreeAdmissionProbe = process.env.KONI_PROVIDER_FREE_RELEASE_PROBE === "1";
      if (
        providerFreeAdmissionProbe &&
        (process.env.NODE_ENV !== "test" || process.env.KONI_AUTHORITY_DAEMON !== "1")
      ) {
        throw new CliUsageError(
          "provider-free authority admission is restricted to the packaged release probe",
        );
      }
      await dependencies.serve({
        projectRoot,
        version: KONI_CORE_API_VERSION,
        ...(providerFreeAdmissionProbe ? { providerFreeAdmissionProbe: true } : {}),
      });
      return 0;
    }
  }
}

interface ParsedCli {
  command?:
    | "init"
    | "update"
    | "conflicts"
    | "start"
    | "stop"
    | "restart"
    | "status"
    | "config"
    | "tui"
    | "run"
    | "resume"
    | "approve"
    | "authority";
  positionals: string[];
  root?: string;
  profilePackage?: string;
  runType?: string;
  target?: string;
  newTarget: boolean;
  from?: string;
  goal?: string;
  /** Additional intake answers for run types that require more than the objective field. */
  fields?: Record<string, string>;
  runId?: string;
  previewSha256?: string;
  conflictResolution?: "keep_project" | "accept_upstream";
  apply: boolean;
  json: boolean;
  help: boolean;
  version: boolean;
}

function parseCli(argv: readonly string[]): ParsedCli {
  const result: ParsedCli = {
    positionals: [],
    newTarget: false,
    apply: false,
    json: false,
    help: false,
    version: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--help" || argument === "-h") result.help = true;
    else if (argument === "--version" || argument === "-V") result.version = true;
    else if (argument === "--json") result.json = true;
    else if (argument === "--root") result.root = requireOptionValue(argv, ++index, argument);
    else if (argument === "--profile-package")
      result.profilePackage = requireOptionValue(argv, ++index, argument);
    else if (argument === "--type" || argument === "--run-type")
      result.runType = requireOptionValue(argv, ++index, argument);
    else if (argument === "--target") result.target = requireOptionValue(argv, ++index, argument);
    else if (argument === "--new-target") result.newTarget = true;
    else if (argument === "--from") result.from = requireOptionValue(argv, ++index, argument);
    else if (argument === "--goal") result.goal = requireOptionValue(argv, ++index, argument);
    else if (argument === "--field") {
      const entry = requireOptionValue(argv, ++index, argument);
      const separator = entry.indexOf("=");
      if (separator < 1) {
        throw new CliUsageError(`--field expects <id>=<value>, received ${entry}`);
      }
      result.fields = {
        ...result.fields,
        [entry.slice(0, separator)]: entry.slice(separator + 1),
      };
    } else if (argument === "--run") result.runId = requireOptionValue(argv, ++index, argument);
    else if (argument === "--preview")
      result.previewSha256 = requireOptionValue(argv, ++index, argument);
    else if (argument === "--keep-project")
      result.conflictResolution = oneConflictResolution(result, "keep_project");
    else if (argument === "--accept-upstream")
      result.conflictResolution = oneConflictResolution(result, "accept_upstream");
    else if (argument === "--apply") result.apply = true;
    else if (argument.startsWith("-")) throw new CliUsageError(`unknown option: ${argument}`);
    else if (result.command === undefined) {
      if (!isCommand(argument)) throw new CliUsageError(`unknown command: ${argument}`);
      result.command = argument;
    } else result.positionals.push(argument);
  }
  return result;
}

function requireOptionValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("-"))
    throw new CliUsageError(`${option} requires a value`);
  return value;
}

function isCommand(value: string): value is NonNullable<ParsedCli["command"]> {
  return new Set([
    "init",
    "update",
    "conflicts",
    "start",
    "stop",
    "restart",
    "status",
    "config",
    "tui",
    "run",
    "resume",
    "approve",
    "authority",
  ]).has(value);
}

function oneConflictResolution(
  parsed: ParsedCli,
  resolution: NonNullable<ParsedCli["conflictResolution"]>,
): NonNullable<ParsedCli["conflictResolution"]> {
  if (parsed.conflictResolution !== undefined && parsed.conflictResolution !== resolution) {
    throw new CliUsageError("choose only one of --keep-project or --accept-upstream");
  }
  return resolution;
}

function parseSha256(value: string, option: string): Sha256Digest {
  if (!/^sha256:[a-f0-9]{64}$/u.test(value))
    throw new CliUsageError(`${option} must be a canonical sha256 digest`);
  return value as Sha256Digest;
}

function conflictCatalog(value: unknown): {
  conflicts: Array<{ path: string; reason: string }>;
} & Record<string, unknown> {
  if (
    !isRecord(value) ||
    value.protocol !== "koni.profile-upstream-conflict-catalog.v1" ||
    !Array.isArray(value.conflicts) ||
    value.conflicts.some(
      (entry) =>
        !isRecord(entry) || typeof entry.path !== "string" || typeof entry.reason !== "string",
    )
  ) {
    throw new Error("authority returned an invalid upstream conflict catalog");
  }
  return value as { conflicts: Array<{ path: string; reason: string }> } & Record<string, unknown>;
}

function conflictInspection(value: unknown): {
  lifecycleGeneration: number;
  conflict: { path: string; title: string; reason: string; currentSha256: Sha256Digest | null };
  currentText: string | null;
  upstreamText: string | null;
} & Record<string, unknown> {
  if (
    !isRecord(value) ||
    value.protocol !== "koni.profile-upstream-conflict-inspection.v1" ||
    !Number.isSafeInteger(value.lifecycleGeneration) ||
    !isRecord(value.conflict) ||
    typeof value.conflict.path !== "string" ||
    typeof value.conflict.title !== "string" ||
    typeof value.conflict.reason !== "string" ||
    (value.conflict.currentSha256 !== null && !isSha256Digest(value.conflict.currentSha256)) ||
    (value.currentText !== null && typeof value.currentText !== "string") ||
    (value.upstreamText !== null && typeof value.upstreamText !== "string")
  ) {
    throw new Error("authority returned an invalid upstream conflict inspection");
  }
  return value as ReturnType<typeof conflictInspection>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function defaultTargetBranch(projectRoot: string): Promise<string> {
  const identity = await GitClient.discover(projectRoot);
  const branches = await new GitClient(identity.worktreeRoot).recentBranches(1);
  const branch = branches[0];
  if (branch === undefined)
    throw new CliUsageError("repository has no local branch; pass --target after creating one");
  return branch.name;
}

function print(io: KoniCliIO, json: boolean, value: unknown, lines: readonly string[]): void {
  io.stdout(json ? `${JSON.stringify(value, null, 2)}\n` : `${lines.join("\n")}\n`);
}

/** One glanceable line per run; attention states shout so a wedged run is never mistaken for progress. */
function runStatusLine(run: MonitorRunSummary): string {
  const phase =
    run.phase === "blocked" || run.phase === "failed" ? run.phase.toUpperCase() : run.phase;
  const stage = run.stage === undefined ? "" : ` · ${run.stage}`;
  return `${phase}${stage} · tickets ${run.tickets.completed}/${run.tickets.total} · agents ${run.agents.active} active`;
}

function helpText(): string {
  return (
    `Koni ${KONI_CORE_API_VERSION}\n\n` +
    "Usage:\n" +
    "  koni init [coding|research] [--profile-package PATH] [--root PATH]\n" +
    "  koni update [--profile-package PATH] [--root PATH] [--preview SHA256 --apply]\n" +
    "  koni conflicts [PATH] [--keep-project|--accept-upstream] [--root PATH]\n" +
    "  koni start [--root PATH]\n" +
    "  koni stop [--root PATH]\n" +
    "  koni restart [--root PATH]\n" +
    "  koni status [--root PATH] [--json]\n" +
    "  koni config validate [--root PATH] [--json]\n" +
    "  koni run --goal TEXT [--field ID=VALUE]... [--type <run-type>] [--target BRANCH] [--new-target [--from REF]]\n" +
    "    Available run types come from the project's compiled profile and configuration.\n" +
    "    --field answers additional required intake (repeatable), e.g. --field hypothesis='...'.\n" +
    "    --new-target branches a not-yet-existing --target from --from (default: current branch).\n" +
    "  koni resume --run RUN_ID [--root PATH]  Resume a paused run or retry a blocked run\n" +
    "  koni approve --run RUN_ID [--root PATH] Approve a run waiting at its approval gate\n" +
    "  koni tui [--root PATH]\n\n" +
    "The TUI opens only in the terminal where `koni tui` is invoked; Koni never creates panes.\n"
  );
}

export class CliUsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

if (isDirectInvocation()) {
  runKoniCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`koni: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = error instanceof CliUsageError ? 2 : 1;
    },
  );
}

export function isDirectInvocation(
  invoked: string | undefined = process.argv[1],
  modulePath: string = fileURLToPath(import.meta.url),
): boolean {
  if (invoked === undefined) return false;
  try {
    return realpathSync(path.resolve(invoked)) === realpathSync(modulePath);
  } catch {
    return false;
  }
}
