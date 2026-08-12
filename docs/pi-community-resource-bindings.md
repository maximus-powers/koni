# Pi resources in Koni

Pi owns Koni's package and resource environment. There is no Koni-side package registry.

## Native ownership

Use Pi's normal settings and repository structure:

```text
.pi/settings.json
.pi/skills/
.pi/extensions/
.pi/prompts/
.pi/themes/
.agents/skills/
AGENTS.md
```

Pi packages may contribute skills, prompts, themes, and executable extensions. Koni asks Pi's
package manager to resolve the same global and project inventory ordinary Pi sees. Missing
configured packages follow Pi's normal installation path when a future run or `config resolve-agent`
needs them.

`koni init` and `koni update` merge one required project package entry:

```json
{
  "packages": ["git:github.com/obra/superpowers"]
}
```

This is a field-level merge. Existing packages and unrelated settings are preserved. Koni records
whether it added the entry; a user edit to that owned entry becomes an explicit conflict instead of
being overwritten.

## Per-agent narrowing

An agent inherits the full resolved Pi environment unless its `.koni/agents/<id>.yaml` narrows it:

```yaml
pi:
  settings:
    packages:
      - source: git:github.com/obra/superpowers
        skills:
          - skills/using-superpowers/**
          - skills/systematic-debugging/**
        extensions: []
    skills:
      - skills/using-superpowers/**
      - skills/systematic-debugging/**
```

The overlay cannot install an unconfigured package or name a resource absent from Pi's inventory.
Positive filters must match. This makes the agent file a readable least-resource policy rather than
a second package manager.

## Autonomous extension boundary

Pi extensions are trusted executable code in an interactive Pi process. Koni does not import an
unknown extension into its authority or contained agents merely because Pi resolved it.

Every resolved extension appears in agent diagnostics as one of:

- `compatible`, with a named Koni-owned containment adapter; or
- `interactive_only / excluded`, when no adapter exists.

The default is exclusion. An adapter must map to existing compiler-authorized tools and retain the
attempt's path, network, lifecycle, and receipt boundaries. Installing an extension does not grant
it autonomous Koni authority.

## Immutable runs

At run creation Koni pins each selected skill's complete bounded, no-symlink file closure plus
repository context and configuration hashes. Package updates and Pi-setting changes affect future
runs only. Existing runs and recovery attempts use their authenticated snapshot.

Inspect the result before running:

```sh
koni config resolve-agent run-planner --root .
koni config resolve-agent reviewer --run-type medium --root . --json
```
