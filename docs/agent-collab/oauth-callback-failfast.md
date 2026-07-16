# OAuth callback fail-fast

## Lease

- Owner: `oauth_callback_failfast/root`
- Source: `runtime/pi-host/src/runtime.ts`
- Tests: `runtime/pi-host/test/runtime.test.ts`
- Exclusions: no credential, browser, auth, install, inference, project, run, cockpit, or live-process action.

## Pi 0.80.7 behavior proved from the pinned source

Pi's `startLocalOAuthServer()` binds `127.0.0.1:1455`. Its listener `error` handler does not
reject or publish a typed failure: it resolves a substitute server whose `waitForCode()` returns
`null`. `loginOpenAICodex()` has already started the concurrent `manual_code` promise; after the
null callback result it awaits that promise. Koni intentionally leaves the prompt pending because
the ordinary successful browser flow needs the real callback server to win and abort it. The host
therefore receives no event or prompt distinction it can use to separate a bind failure from a
healthy callback race, and rejecting `manual_code` would regress normal Pi browser login.

## Current transition

Before invoking Pi's browser flow, the host now asks the OS to bind the exact callback endpoint
with an exclusive temporary listener, then closes it before Pi creates its server. A failure maps
directly to one fixed `AUTHENTICATION_FAILED` message:

> OpenAI Codex browser sign-in cannot use localhost port 1455. Close the process using that port,
> then try signing in again.

The raw socket error is never projected. Pi is not invoked, the credential store is unchanged, and
the normal global login `finally` path still clears the timeout/controller. Device-code flow is
unchanged. The existing manual-code behavior remains pending until Pi's per-prompt abort, so the
successful browser race is preserved.

This is deliberately an OS capability probe rather than a timing inference from Pi's prompt order.
There is an unavoidable, very small bind/close-to-Pi-bind race because Pi 0.80.7 does not expose
its listener or bind failure. A process that takes port 1455 in precisely that gap can still reach
the existing bounded global login timeout. Eliminating that residual race requires an upstream Pi
change that rejects listener failure (or accepts an already-bound server); Koni must not guess from
the indistinguishable manual prompt.

## Verification

- `npm run typecheck` — passed.
- `npm test -- --run test/runtime.test.ts` — passed, **43/43**.
- `npm test` — passed package-wide, **53/53** across both test files.
- Regression coverage reserves an OS-assigned loopback port, proves the probe returns only the
  fixed message while occupied, proves the same endpoint succeeds once released, proves Pi login
  is not called on failure, proves no credential is written, and proves a subsequent browser login
  can recover (no lingering login controller).

No real port 1455 listener, OAuth request, browser launch, credential operation, runtime install,
project mutation, or run/process action was performed by this lane.
