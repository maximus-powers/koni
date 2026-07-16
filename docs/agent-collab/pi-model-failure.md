# Pi zero-token model failure audit

- Owner: `pi-model-failure/root`
- Status: `review_complete` — likely request-shape defect isolated; live confirmation belongs to
  `primary-integrator/root`
- Started: 2026-07-14 America/Phoenix
- Exact lease: read-only inspection of the pinned Pi SDK/provider, Koni's model/request mapping,
  tests, and packaged hashes; this mailbox is the only write.
- Explicit exclusions: no credential reads or writes, no run-state reads or writes, no network
  request, no process/control action, no binary/install mutation, and no source edit.

## Observed boundary supplied by the primary integrator

The first contained Medium planning turn selected `gpt-5.6-sol`, reached the provider, then ended
after roughly 2.7 seconds with zero usage, no assistant content, and the sanitized terminal event
`pi_runtime_error: Pi provider turn failed`. OAuth had already completed successfully. Those facts
place the failure before the first billable/streamed assistant message, but the current generic
projection does not preserve the provider's rejection class.

## Evidence

### 1. The failed packaged host added a field which the pinned Codex request builder omits

The installed acceptance host is 873,700 bytes with SHA-256
`257c37416e39db82c65464497305a2e72730cc36ec7d7464f8d5ed3414bbe161`. It is byte-identical to the
pre-fix release artifact recorded by the frozen matrix. Its bundled runtime contains:

```text
return { ...prior, max_output_tokens: maxTokens };
```

at bundle line 21,940. In contrast, Pi 0.80.7's pinned
`api/openai-codex-responses.js:339-377` builds the ChatGPT Codex body without
`max_output_tokens`; `streamSimple` carries `maxTokens` as an option, but this provider-specific
builder deliberately does not serialize it. Other Pi Responses transports explicitly serialize
the field, so this is a provider distinction rather than a global SDK omission.

During this read-only audit, the primary integrator removed only Koni's extra `onPayload`
injection and added an exact local payload-capture regression. Current source
`runtime.ts:304-331` still computes and passes the remaining compiler budget to Pi for local
cross-round enforcement, while `runtime.test.ts:539-615` proves the ChatGPT Codex payload itself
has no `max_output_tokens`. The rebuilt 873,205-byte source artifact is SHA-256
`5cc542d7a3e01af391af688ebba8ab0a35805f184544e923a0cf111a94aa415c`; it is intentionally
different from the still-failed installed host above. The primary integrator reports the host
matrix green at 34/34 on these corrected source bytes. I did not rerun or install it.

### 2. `gpt-5.6-sol` and `max` are valid in the pinned local registry

The lockfile pins both `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` to exact version
0.80.7. The pinned `openai-codex.models.js:101-120` declares `gpt-5.6-sol` with provider
`openai-codex`, API `openai-codex-responses`, a 372,000-token context window, a 128,000-token
maximum, and a thinking map containing `max -> max`. Koni's launcher (`agent.rs:680-702`) requires
an exact provider/model match and rejects an unsupported thinking level before it starts the turn.
Because the observed turn reached a provider failure rather than either local error, the model ID
and thinking-level mapping were accepted locally exactly as configured.

This registry is static. Its presence proves request compatibility, not that a particular ChatGPT
account is entitled to every listed model. Entitlement therefore remains a possible alternative,
but no local evidence elevates it above the known request mutation.

### 3. Package/source skew does not explain the original failure

Before the fix, the acceptance host and the frozen source artifact had the same 873,700-byte
bundle and `257c3741...` digest. The packaged Node digest is
`0d005c18e095027ca8f9fe1cc1126f767ee4ad7b004f4d6fb781ec4228a7c5d1`, and the installed Koni
binary digest is `5490e73bbf73a8042439a736c89a67b876d2658ed4d5925226da64971d22b931`, matching the isolated
acceptance checkpoint. The defect was therefore in the frozen release bytes, not a stale or
partial copy.

## Ranked hypotheses

1. **High confidence — backend request rejection caused by Koni's extra
   `max_output_tokens`.** This is the only known difference from Pi's provider-specific builder,
   it was present in the exact failed artifact, and immediate zero-token termination is the
   expected shape for request validation. The corrected local regression directly guards the
   request-shape invariant.
2. **Medium-low confidence — the authenticated account lacks `gpt-5.6-sol` and/or `max`
   entitlement.** The local registry cannot prove account access, and an entitlement rejection
   can also occur before usage. Against it: both identifiers are first-class in the pinned Codex
   registry, local mapping is exact, and a concrete invalid field is already present in the failed
   request.
3. **Low confidence — another planning payload/tool-schema incompatibility.** The planning turn
   includes read-only tools, reasoning, and a substantial prompt, so another request-validation
   defect is possible. However those shapes come from the pinned Codex builder and Koni's existing
   broker catalog; no second divergence was found.
4. **Very low confidence — OAuth, package skew, unknown model, or thinking-name translation.**
   Login succeeded, source/install hashes matched at failure time, and all local model/thinking
   validation completed before the provider call.

## Safe discriminating test

Keep every variable fixed and change only the request field:

1. Package the corrected `5cc542d7...` host through the primary integrator's isolated prefix;
   verify the installed host digest equals the corrected source digest and contains no
   `max_output_tokens` property.
2. Retry the same contained planning stage with the same OAuth credential, model
   `gpt-5.6-sol`, thinking level `max`, prompt, tools, and compiler budget. Do not switch models on
   this first retry.
3. A nonzero usage/message event confirms the request-field diagnosis. A second immediate
   zero-token rejection disproves sufficiency; only then test one variable at a time:
   `sol/max -> sol/xhigh -> terra/xhigh`. Success at the first transition isolates thinking-level
   entitlement; success only at the second isolates model entitlement. Failure of all three points
   to auth/account or another common request/transport shape.

The first retry is preferable to a broad model matrix: it spends the minimum tokens and produces
the strongest causal evidence. The primary integrator owns packaging, guarded retry, and any live
state transition.

## Fix and follow-up

The narrow source fix is correct: retain compiler-side/local cumulative budget accounting and
stop further provider rounds at the remaining limit, but do not invent a ChatGPT Codex wire field
which the pinned provider intentionally omits. Keep the payload-capture regression as a required
host release gate.

There is also a diagnostics gap. `runtime.ts` turns every assistant `stopReason == "error"` into
the same `Pi provider turn failed`, so request validation, entitlement, usage limit, auth, and
transport failures are indistinguishable after redaction. A later bounded repair should preserve
only a stable allowlisted provider category/status (never a raw response body or credential) in
the durable runtime event. This does not block testing the narrow fix, but it will prevent future
zero-token failures from requiring inference.

## Verification and coordination

- Read the central registry plus the current Pi architect, SDK-host, runtime-core, direct-broker,
  final-runtime-audit, Updog-smoke, and primary-integrator handoffs before inspection.
- Confirmed exact Pi package versions and lockfile integrity metadata without running npm or
  modifying generated artifacts.
- Confirmed the failed installed bundle contained the injected field, and the corrected source
  bundle does not.
- No credential, network, run, process, binary, install, project, or source mutation was performed
  by this lane.

