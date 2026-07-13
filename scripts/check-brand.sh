#!/usr/bin/env bash
set -euo pipefail

tracked_paths=(
  -- .
  ':(exclude)target/**'
  ':(exclude)apps/docs/node_modules/**'
  ':(exclude)apps/docs/.next/**'
)
forbidden_repo="real""-nigga-harness"
legacy_product="pytha""goras"
legacy_upper="PYTHA""GORAS"
legacy_title="Pytha""goras"

if git grep -n -i -e "$forbidden_repo" "${tracked_paths[@]}"; then
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

if git grep -n -i -e "$legacy_product" -- . \
  ":(exclude)$legacy_code" \
  ":(exclude)$legacy_docs" \
  ":(exclude)$legacy_site"; then
  echo "error: legacy product name remains outside the migration allowlist" >&2
  exit 1
fi

# Keep the narrow migration exceptions auditable instead of exempting whole
# files from the brand gate. Any added occurrence must be reviewed here.
test "$(grep -Eic "$legacy_product" "$legacy_code")" -eq 4
grep -Eq "LEGACY_PROFILE_DIRECTORY.*$legacy_product" "$legacy_code"
grep -Eq "migration.*${legacy_product}-to-koni" "$legacy_code"
grep -Eq "replace.*$legacy_upper.*KONI" "$legacy_code"
grep -Eq "replace.*$legacy_title.*Koni" "$legacy_code"

for migration_surface in "$legacy_docs" "$legacy_site"; do
  test "$(grep -Eic "$legacy_product" "$migration_surface")" -eq 1
  grep -Eq "\\.codex/$legacy_product/" "$migration_surface"
done

echo "Brand audit passed"
