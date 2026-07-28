# Security policy

## Supported versions

Security fixes apply to the latest release only.

| Version             | Supported   |
| ------------------- | ----------- |
| Latest release      | Yes         |
| Earlier releases    | No          |
| Unreleased branches | Best effort |

## Report a vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub's
[private vulnerability reporting](https://github.com/maximus-powers/koni/security/advisories/new).
Include the affected version, platform, threat model, reproduction, impact, and suggested
mitigation.

Remove credentials, private repository content, and unnecessary personal data. Maintainers will
acknowledge the report within seven days.

## Security boundaries

Sensitive areas include:

- command containment and environment inheritance;
- Pi runtime, provider, and tool policy;
- path traversal, symlink, and project-root discovery;
- Git ref, branch, worktree, process, and resource ownership;
- receipt or configuration-hash forgery;
- cross-run authority and shared-lock handling;
- profile migration, recovery, rollback, and deletion;
- untrusted tool results, artifacts, and external-provider input.

Köni is not a sandbox for untrusted repositories or programs. Read [Maturity](docs/maturity.md) for
platform limitations.
