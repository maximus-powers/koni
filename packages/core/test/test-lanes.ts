export const exclusiveTestFiles = [
  "test/authority-server.test.ts",
  "test/operator-surface.test.ts",
  "test/pi-attempt-process.test.ts",
] as const;

export const exclusiveTestReasons = {
  "test/authority-server.test.ts":
    "Binds real authority sockets and exercises lease, startup, quiesce, and stop lifecycle races.",
  "test/operator-surface.test.ts":
    "Exercises real authority bind, winner, and handoff timing across competing lifecycle owners.",
  "test/pi-attempt-process.test.ts":
    "Supervises real process groups and validates signal, crash, descendant cleanup, and timeout races.",
} satisfies Record<(typeof exclusiveTestFiles)[number], string>;
