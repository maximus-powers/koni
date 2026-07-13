# Security policy

## Supported versions

Köni is pre-1.0. Security fixes are applied to the latest released minor
version only.

| Version | Supported |
| --- | --- |
| Latest `0.1.x` | Yes |
| Earlier releases | No |
| Unreleased branches | Best effort |

## Report a vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub's
[private vulnerability reporting](https://github.com/maximus-powers/koni/security/advisories/new)
and include:

- the affected version and platform;
- the threat model and required attacker access;
- a minimal reproduction or proof of concept;
- expected and observed containment or authorization behavior;
- potential impact;
- any suggested mitigation.

Remove credentials, private repository content, and unnecessary personal data.
You should receive an acknowledgement within seven days. Maintainers will
coordinate validation, remediation, release timing, and credit with the
reporter.

## Security boundaries

Particularly sensitive areas include:

- command containment and environment inheritance;
- Codex sandbox, approval, and runtime broker policy;
- path traversal, symlink, and project-root discovery;
- Git ref, branch, worktree, process, and resource ownership;
- receipt or configuration-hash forgery;
- cross-run authority and shared-lock handling;
- migration, recovery, rollback, and deletion transactions;
- untrusted result protocols, artifacts, and external-provider input.

Köni is not currently a sandbox for wholly untrusted repositories or programs.
Read [Maturity](docs/maturity.md) for platform limitations.
