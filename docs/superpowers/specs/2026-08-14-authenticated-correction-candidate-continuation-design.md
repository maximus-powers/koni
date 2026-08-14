# Authenticated Correction Candidate Continuation Design

## Problem

Change control currently checkpoints and archives a held source ticket correctly, then resets the
ticket to a fresh Git cycle rooted at the run head. That preserves audit history but discards the
reviewed repository candidate from the next correction workspace. Repeated compiler-routed repair
therefore makes each worker reconstruct the same in-scope implementation from scratch instead of
correcting the last authenticated candidate.

The MUAT smoke run reproduced this across seven consecutive asset cycles. Every cycle was based on
the same run OID, each archived candidate changed only the same two granted asset files, and every
successor started again at the unchanged run OID.

## Invariant

A fresh correction epoch may start from the immediately retired candidate only when a durable
authority record proves all of the following:

- the candidate belongs to the held source ticket and its exact retired Git cycle;
- the archive ref still names the recorded candidate OID;
- source release was authorized by an exact compiler-routed planned repair, a reviewed no-op, or a
  completed approved application;
- the record binds the exact proposal request, release decision, prior and next execution epochs,
  and the source's current immutable compiler projection;
- every candidate change remains inside the successor ticket's effective write grant; and
- the candidate merges cleanly onto the current run head.

The continuation record is append-only and hash-bound. The successor Git cycle records the exact
continuation-authority digest it consumed. The candidate is merged into a new single-parent ticket
seed commit; the archived candidate and its original history remain immutable audit evidence. Later
audit-only proposal history does not reinterpret the frozen release proof. If the run head advances
before the continued worker starts, the unused checkout is refreshed in the same execution epoch and
the same authenticated candidate is cleanly re-applied to the newer run head.

## Boundaries

- Rejected, generic-cancelled, operator-superseded, or otherwise unauthenticated proposals do not
  authorize candidate continuation.
- A scope contraction, archive mismatch, missing object, or merge conflict fails closed before a new
  checkout is materialized.
- A retired cycle created for another proposal request may support legacy blank release, but it
  cannot authorize repository-byte continuation for the current request.
- No prior provider session, attempt status, review verdict, or semantic graph mutation is carried
  forward. Only authenticated repository bytes within the current grant continue.
- Legacy runs and tickets without a continuation record retain the existing run-head-based cycle
  behavior without migration.
- Compiler semantics and profile policy remain unchanged; this is a generic Git/lifecycle authority
  invariant.

## Recovery

The continuation authority is installed atomically with source-hold release and epoch reset after
the supersession archive is durable. Ticket-cycle allocation binds the latest authority for the
exact current epoch. Git intent recovery retains the computed seed commit and authority digest, so a
crash before ref/worktree creation resumes the same materialization rather than silently falling
back to a blank cycle or choosing another archive.

## Verification

Tests must prove clean in-scope continuation, path-scope rejection, merge-conflict rejection,
archive/OID mismatch rejection, exact eligible release routing, direct-store forgery rejection,
legacy fresh-cycle behavior, and cold recovery between release and successor materialization.
