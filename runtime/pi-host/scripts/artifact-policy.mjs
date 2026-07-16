const FORBIDDEN_RUNTIME_MARKERS = [
  "child_process",
  "@earendil-works/pi-ai/compat",
  "pi-coding-agent",
  "importOAuthModule",
  "loadOpenAICodexOAuth",
  "./openai-codex.ts",
];

const REQUIRED_STATIC_OAUTH_MARKERS = [
  "https://auth.openai.com",
  "/api/accounts/deviceauth/usercode",
  "/api/accounts/deviceauth/token",
  "OpenAI Codex token refresh",
];

const LOCAL_DYNAMIC_IMPORTS = [
  /\bimport\(\s*["'`]\.\.?\//u,
  /\bimport\(\s*__rewriteRelativeImportExtension\d*\(\s*runtimeSpecifier\s*\)\s*\)/u,
];

const ALLOWED_DYNAMIC_IMPORT_LINES = [
  /^\s*(?:var )?importNodeModule = \(specifier\) => import\(__rewriteRelativeImportExtension\(specifier\)\);\s*$/u,
  /^\s*import\(["']node:[^"']+["']\)\.then\(/u,
];

export function assertStandaloneBundle(bundleText) {
  for (const marker of FORBIDDEN_RUNTIME_MARKERS) {
    if (bundleText.includes(marker)) throw new Error(`bundle retained forbidden runtime marker ${marker}`);
  }
  for (const pattern of LOCAL_DYNAMIC_IMPORTS) {
    if (pattern.test(bundleText)) throw new Error(`bundle retained unresolved local dynamic import ${pattern}`);
  }
  for (const line of bundleText.split("\n").filter((candidate) => candidate.includes("import("))) {
    if (!ALLOWED_DYNAMIC_IMPORT_LINES.some((pattern) => pattern.test(line))) {
      throw new Error(`bundle retained an unclassified dynamic import: ${line.trim()}`);
    }
  }
  for (const match of bundleText.matchAll(/\bimportNodeModule\(([^)\n]*)\)/gu)) {
    if (!/^\s*["']node:[^"']+["']\s*$/u.test(match[1] ?? "")) {
      throw new Error(`bundle invoked its Node-only dynamic loader with ${match[1] ?? "unknown input"}`);
    }
  }
  for (const marker of REQUIRED_STATIC_OAUTH_MARKERS) {
    if (!bundleText.includes(marker)) throw new Error(`bundle omitted statically bound OAuth marker ${marker}`);
  }
}
