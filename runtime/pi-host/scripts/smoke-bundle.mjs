import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceBundle = resolve(packageRoot, "dist/koni-pi-host.mjs");
const isolatedDirectory = await mkdtemp(join(tmpdir(), "koni-pi-host-smoke-"));
const isolatedBundle = join(isolatedDirectory, "koni-pi-host.mjs");

try {
  await copyFile(sourceBundle, isolatedBundle);
  const result = spawnSync(process.execPath, [isolatedBundle], {
    cwd: isolatedDirectory,
    env: {
      HOME: isolatedDirectory,
      NODE_PATH: join(isolatedDirectory, "no-node-modules"),
      PATH: process.env.PATH ?? "",
      TMPDIR: isolatedDirectory,
    },
    encoding: "utf8",
    timeout: 5_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`isolated bundle was terminated by ${result.signal}`);
  if (result.status === 0) throw new Error("isolated bundle unexpectedly started without private fd 3");
  if (result.stdout.length !== 0) throw new Error("isolated bundle wrote non-protocol text to stdout");
  if (/ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find (?:module|package)/u.test(result.stderr)) {
    throw new Error(`isolated bundle retained a package import: ${result.stderr.trim()}`);
  }
  if (!/(?:fd 3|file descriptor|EBADF|EINVAL|ENOTTY|uv_pipe_open|credential channel)/iu.test(result.stderr)) {
    throw new Error(`isolated bundle failed before the expected fd 3 boundary: ${result.stderr.trim()}`);
  }

  const bundleUrl = pathToFileURL(isolatedBundle).href;
  const oauthSmokeSource = `
    const fail = (message) => { throw new Error(message); };
    const json = (value, status = 200) => new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });
    const jwt = (accountId) => {
      const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({
        "https://api.openai.com/auth": { chatgpt_account_id: accountId },
      })).toString("base64url");
      return header + "." + payload + ".signature";
    };

    const imported = await import(${JSON.stringify(bundleUrl)});
    if (typeof imported.koniOpenAICodexProvider !== "function") fail("bundle did not export its static provider");
    const provider = imported.koniOpenAICodexProvider();
    const oauth = provider.auth.oauth;
    if (!oauth) fail("bundle provider omitted OAuth");

    const direct = await oauth.toAuth({
      type: "oauth",
      access: "isolated-access-before-refresh",
      refresh: "isolated-refresh-before-refresh",
      expires: Date.now() + 60_000,
      accountId: "account-isolated",
    });
    if (direct.apiKey !== "isolated-access-before-refresh") fail("toAuth did not return the access token");

    const refreshedAccess = jwt("account-isolated");
    const loginAccess = jwt("account-device");
    const operations = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://auth.openai.com/api/accounts/deviceauth/usercode") {
        operations.push("device_user_code");
        return json({ device_auth_id: "device-isolated", user_code: "KONI-CODE", interval: 0 });
      }
      if (url === "https://auth.openai.com/api/accounts/deviceauth/token") {
        operations.push("device_token");
        return json({ authorization_code: "authorization-isolated", code_verifier: "verifier-isolated" });
      }
      if (url === "https://auth.openai.com/oauth/token") {
        const body = new URLSearchParams(String(init.body ?? ""));
        const grant = body.get("grant_type");
        operations.push(grant ?? "missing_grant");
        if (grant === "refresh_token") {
          return json({ access_token: refreshedAccess, refresh_token: "refresh-rotated", expires_in: 3600 });
        }
        if (grant === "authorization_code") {
          return json({ access_token: loginAccess, refresh_token: "refresh-device", expires_in: 3600 });
        }
      }
      return json({ error: "unexpected isolated OAuth request", url }, 500);
    };

    const refreshed = await oauth.refresh({
      type: "oauth",
      access: "expired-access",
      refresh: "expired-refresh",
      expires: Date.now() - 1,
      accountId: "account-isolated",
    });
    if (refreshed.access !== refreshedAccess || refreshed.refresh !== "refresh-rotated") {
      fail("expired credential refresh did not use bundled OAuth");
    }
    if (refreshed.accountId !== "account-isolated") fail("refresh did not recover the JWT account id");

    const notifications = [];
    const loggedIn = await oauth.login({
      signal: new AbortController().signal,
      prompt: async (prompt) => {
        if (prompt.type === "select") return "device_code";
        fail("device login unexpectedly requested " + prompt.type);
      },
      notify: (event) => notifications.push(event),
    });
    if (loggedIn.access !== loginAccess || loggedIn.refresh !== "refresh-device") {
      fail("device-code login did not use bundled OAuth");
    }
    if (loggedIn.accountId !== "account-device") fail("device login did not recover the JWT account id");
    if (!notifications.some((event) => event.type === "device_code" && event.userCode === "KONI-CODE")) {
      fail("device-code login did not publish its interaction");
    }
    if (operations.join(",") !== "refresh_token,device_user_code,device_token,authorization_code") {
      fail("unexpected OAuth operation order: " + operations.join(","));
    }
    process.stdout.write("isolated static OAuth paths passed\\n");
  `;
  const oauthResult = spawnSync(process.execPath, ["--input-type=module", "--eval", oauthSmokeSource], {
    cwd: isolatedDirectory,
    env: {
      HOME: isolatedDirectory,
      NODE_PATH: join(isolatedDirectory, "no-node-modules"),
      PATH: process.env.PATH ?? "",
      TMPDIR: isolatedDirectory,
    },
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (oauthResult.error) throw oauthResult.error;
  if (oauthResult.signal) throw new Error(`isolated OAuth smoke was terminated by ${oauthResult.signal}`);
  if (oauthResult.status !== 0) {
    throw new Error(`isolated OAuth smoke failed: ${oauthResult.stderr.trim() || oauthResult.stdout.trim()}`);
  }
  if (oauthResult.stderr.length !== 0) {
    throw new Error(`isolated OAuth smoke wrote stderr: ${oauthResult.stderr.trim()}`);
  }
  if (oauthResult.stdout !== "isolated static OAuth paths passed\n") {
    throw new Error(`isolated OAuth smoke returned unexpected output: ${oauthResult.stdout.trim()}`);
  }
  process.stdout.write(
    "isolated bundle resolved without node_modules, stopped at fd 3, and passed static OAuth smokes\n",
  );
} finally {
  await rm(isolatedDirectory, { recursive: true, force: true });
}
