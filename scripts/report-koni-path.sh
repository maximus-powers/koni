#!/usr/bin/env bash
set -euo pipefail

prefix="${1:?usage: report-koni-path.sh PREFIX}"
active_koni="$(command -v koni 2>/dev/null || true)"
expected_koni="$prefix/bin/koni"
if [[ "$active_koni" == "$expected_koni" ]]; then
  exit 0
fi
if [[ -n "$active_koni" ]]; then
  echo "The installed Koni command is currently shadowed by: $active_koni"
fi
echo "Prepend the activated Koni command directory to this shell's PATH:"
echo "  export PATH=\"$prefix/bin:\$PATH\""
