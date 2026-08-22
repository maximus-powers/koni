export const exclusiveTestFiles = [
  "test/authority-server.test.ts",
  "test/operator-surface.test.ts",
  "test/pi-attempt-process.test.ts",
  "test/profile-install.test.ts",
  "test/run-authority-engine.test.ts",
] as const;

export const exclusiveTestReasons = {
  "test/authority-server.test.ts":
    "Binds real authority sockets and exercises lease, startup, quiesce, and stop lifecycle races.",
  "test/operator-surface.test.ts":
    "Exercises real authority bind, winner, and handoff timing across competing lifecycle owners.",
  "test/pi-attempt-process.test.ts":
    "Supervises real process groups and validates signal, crash, descendant cleanup, and timeout races.",
  "test/profile-install.test.ts":
    "Monkey-patches process-global fs.promises open/rename and syncs ESM exports to inject fsync crashes; concurrent execution bypassed the instrumentation.",
  "test/run-authority-engine.test.ts":
    "Runs 148 real authority-engine, socket, and child-Git lifecycles with 15-second polling deadlines; four-worker OS contention caused two timing failures.",
} satisfies Record<(typeof exclusiveTestFiles)[number], string>;
