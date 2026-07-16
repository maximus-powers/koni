import { compareUtf8 } from "./canonical.js";

export type DiagnosticSeverity = "error" | "warning";

export interface DiagnosticLocation {
  line: number;
  column: number;
}

export interface CompilerDiagnostic {
  code: string;
  severity: DiagnosticSeverity;
  path: string;
  message: string;
  location?: DiagnosticLocation;
}

export type ValidationResult<Value> =
  | { ok: true; value: Value; diagnostics: readonly CompilerDiagnostic[] }
  | { ok: false; diagnostics: readonly CompilerDiagnostic[] };

export class DiagnosticBag {
  readonly #diagnostics: CompilerDiagnostic[] = [];

  public error(
    code: string,
    path: string,
    message: string,
    location?: DiagnosticLocation,
  ): void {
    this.add({ code, severity: "error", path, message, ...(location === undefined ? {} : { location }) });
  }

  public warning(
    code: string,
    path: string,
    message: string,
    location?: DiagnosticLocation,
  ): void {
    this.add({ code, severity: "warning", path, message, ...(location === undefined ? {} : { location }) });
  }

  public add(diagnostic: CompilerDiagnostic): void {
    this.#diagnostics.push(diagnostic);
  }

  public extend(diagnostics: Iterable<CompilerDiagnostic>): void {
    for (const diagnostic of diagnostics) {
      this.add(diagnostic);
    }
  }

  public hasErrors(): boolean {
    return this.#diagnostics.some((diagnostic) => diagnostic.severity === "error");
  }

  public sorted(): readonly CompilerDiagnostic[] {
    const unique = new Map<string, CompilerDiagnostic>();
    for (const diagnostic of this.#diagnostics) {
      const key = [
        diagnostic.severity,
        diagnostic.code,
        diagnostic.path,
        diagnostic.message,
        diagnostic.location?.line ?? 0,
        diagnostic.location?.column ?? 0,
      ].join("\u0000");
      unique.set(key, diagnostic);
    }
    return [...unique.values()].sort(compareDiagnostics);
  }
}

export function validationSuccess<Value>(
  value: Value,
  diagnostics: Iterable<CompilerDiagnostic> = [],
): ValidationResult<Value> {
  const bag = new DiagnosticBag();
  bag.extend(diagnostics);
  const sorted = bag.sorted();
  if (sorted.some((diagnostic) => diagnostic.severity === "error")) {
    return { ok: false, diagnostics: sorted };
  }
  return { ok: true, value, diagnostics: sorted };
}

export function validationFailure(
  diagnostics: Iterable<CompilerDiagnostic>,
): ValidationResult<never> {
  const bag = new DiagnosticBag();
  bag.extend(diagnostics);
  return { ok: false, diagnostics: bag.sorted() };
}

export function pointer(parent: string, segment: string | number): string {
  const encoded = String(segment).replaceAll("~", "~0").replaceAll("/", "~1");
  return parent === "" ? `/${encoded}` : `${parent}/${encoded}`;
}

function compareDiagnostics(left: CompilerDiagnostic, right: CompilerDiagnostic): number {
  return (
    compareUtf8(left.path, right.path) ||
    compareUtf8(left.code, right.code) ||
    compareUtf8(left.severity, right.severity) ||
    (left.location?.line ?? 0) - (right.location?.line ?? 0) ||
    (left.location?.column ?? 0) - (right.location?.column ?? 0) ||
    compareUtf8(left.message, right.message)
  );
}
