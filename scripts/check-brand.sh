#!/usr/bin/env bash
set -euo pipefail

common=(--hidden -g '!target/**' -g '!apps/docs/node_modules/**' -g '!apps/docs/.next/**' -g '!.git/**')
forbidden_repo="real""-nigga-harness"
legacy_product="pytha""goras"
legacy_upper="PYTHA""GORAS"
legacy_title="Pytha""goras"

if rg -n -i "$forbidden_repo" "${common[@]}" .; then
  echo "error: forbidden pre-release repository name remains" >&2
  exit 1
fi

legacy_paths="$(
  find . \
    -path './.git' -prune -o \
    -path './target' -prune -o \
    -path './apps/docs/node_modules' -prune -o \
    -path './apps/docs/.next' -prune -o \
    -iname "*$legacy_product*" -print
)"
if [[ -n "$legacy_paths" ]]; then
  printf '%s\n' "$legacy_paths"
  echo "error: legacy product name remains in a path" >&2
  exit 1
fi

legacy_code='crates/koni-cli/src/main.rs'
legacy_docs='docs/migration.md'
legacy_site='apps/docs/app/cli/page.tsx'

if rg -n -i "$legacy_product" "${common[@]}" \
  -g "!$legacy_code" \
  -g "!$legacy_docs" \
  -g "!$legacy_site" .; then
  echo "error: legacy product name remains outside the migration allowlist" >&2
  exit 1
fi

# Keep the narrow migration exceptions auditable instead of exempting whole
# files from the brand gate. Any added occurrence must be reviewed here.
test "$(rg -i -c "$legacy_product" "$legacy_code")" -eq 4
rg -q "LEGACY_PROFILE_DIRECTORY.*$legacy_product" "$legacy_code"
rg -q "migration.*${legacy_product}-to-koni" "$legacy_code"
rg -q "replace.*$legacy_upper.*KONI" "$legacy_code"
rg -q "replace.*$legacy_title.*Koni" "$legacy_code"

for migration_surface in "$legacy_docs" "$legacy_site"; do
  test "$(rg -i -c "$legacy_product" "$migration_surface")" -eq 1
  rg -q "\\.codex/$legacy_product/" "$migration_surface"
done

echo "Brand audit passed"
