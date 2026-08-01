# Generation-Fenced Authority Upgrades

## Problem

A Pi TUI keeps the Koni Core package that it loaded at session start. Development
activation publishes a newer content-addressed package and changes
`$prefix/bin/koni`, but an older TUI can still call its own
`ensureProjectAuthority()` and launch its older daemon after a clean stop. The
repository lease prevents simultaneous authorities, but it does not establish
which installed generation is permitted to acquire the lease.

## Design

The atomically replaced `$prefix/bin/koni` launcher symlink is the active
installation generation. A Core package inside
`$prefix/share/koni/versions/<bundle>/...` derives that launcher path and binds
it to its own exact launcher target.

Before a versioned Core runtime launches an authority, it verifies that the
active launcher still resolves to its own launcher. It passes the binding to
the daemon. The daemon verifies the binding before opening the project store,
includes it in the existing effect-time runtime guard, and monitors it while
running.

When the launcher target changes, the daemon invokes the existing
cross-version `authority.quiesce` control. That operation closes admission,
durably pauses every pausable run, suspends and settles all active agent
sessions and provider exposure, and requests process shutdown only after the
paused records are committed. The normal startup recovery path completes an
interrupted quiesce before reopening admission.

Paused run records retain their existing `resumePhase`, attempts, tickets,
graph, receipts, and usage. A current authority can therefore resume each run
from its most recent proven durable state through the existing `run.resume`
operation. Automatic upgrade handling does not invent a second run snapshot or
rewrite an integrity anchor.

## Failure Behavior

- A stale TUI cannot launch its bundled authority after activation changes.
- A running superseded authority cannot admit a new effect after its runtime
  guard observes the changed launcher.
- Upgrade quiescence retries revision/busy races until the existing
  non-interruptible lifecycle boundary settles.
- A crash during quiescence leaves the existing durable quiesce tombstone.
  Startup recovery finishes settlement before accepting clients.
- A run whose bytes do not match its authority anchor remains fail-closed and
  is never silently re-anchored.
- Non-versioned source/test installations do not gain an ambient global
  launcher dependency.

## Verification

Unit tests cover active binding discovery, stale binding rejection, change
observation, and abortable monitoring. Existing authority-engine tests remain
the proof that quiescence pauses runs, removes live sessions, survives a crash,
and permits explicit resume.

