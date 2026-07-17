// Stdout is the authenticated framing channel. Redirect ordinary diagnostics before dynamically
// importing Pi or any provider package so dependency logging cannot be mistaken for authority data.
import { assertRuntimeClosureFromEnvironment } from "../runtime/identity.js";

const diagnostic = (...values: unknown[]): void => console.error(...values);
console.log = diagnostic;
console.info = diagnostic;
console.debug = diagnostic;

await assertRuntimeClosureFromEnvironment();
const { runPiAttemptProcessChild } = await import("./attempt-process-child.js");
await runPiAttemptProcessChild();
