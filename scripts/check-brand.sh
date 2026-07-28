#!/usr/bin/env bash
set -euo pipefail

tracked_paths=(
  -- .
)
forbidden_repo="real""-nigga-harness"
legacy_product="pytha""goras"

if git grep -n -i -e "$forbidden_repo" "${tracked_paths[@]}"; then
  echo "error: forbidden pre-release repository name remains" >&2
  exit 1
fi

legacy_paths="$(
  find . \
    -path './.git' -prune -o \
    -path './node_modules' -prune -o \
    -iname "*$legacy_product*" -print
)"
if [[ -n "$legacy_paths" ]]; then
  printf '%s\n' "$legacy_paths"
  echo "error: legacy product name remains in a path" >&2
  exit 1
fi

if git grep -n -i -e "$legacy_product" "${tracked_paths[@]}"; then
  echo "error: legacy product name remains" >&2
  exit 1
fi

echo "Brand audit passed"
