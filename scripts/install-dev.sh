#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
prefix="${KONI_INSTALL_PREFIX:-${HOME}/.local}"
required_node="22.19.0"
required_npm="11.13.0"

if ! command -v node >/dev/null || ! command -v npm >/dev/null || ! command -v pi >/dev/null; then
  echo "Koni requires the user's existing Pi 0.80.10, Node ${required_node}+, and npm ${required_npm}." >&2
  exit 1
fi

node -e '
  const [actual, minimum] = [process.versions.node, process.argv[1]].map((value) => value.split(".").map(Number));
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] > minimum[index]) process.exit(0);
    if (actual[index] < minimum[index]) process.exit(1);
  }
' "$required_node" || {
  echo "Koni requires Node ${required_node}+; found $(node --version)." >&2
  exit 1
}

if [[ "$(npm --version)" != "$required_npm" ]]; then
  echo "Koni development installs require npm ${required_npm}; found $(npm --version)." >&2
  exit 1
fi

if [[ "$(pi --version)" != "0.80.10" ]]; then
  echo "Koni requires the active Pi executable to be 0.80.10; found $(pi --version)." >&2
  exit 1
fi

package_tmp=""
install_lock=""
activation_journal=""
staged_version=""
cleanup() {
  status=$?
  if [[ "$status" -ne 0 && -n "$activation_journal" && -f "$activation_journal" ]]; then
    node "$repo_root/scripts/register-dev-packages.mjs" \
      rollback "$activation_journal" "$prefix/bin/koni" || \
      echo "Koni activation rollback needs attention: $activation_journal" >&2
  fi
  if [[ -n "$staged_version" ]]; then rm -rf -- "$staged_version"; fi
  if [[ -n "$install_lock" ]]; then
    rm -f -- "$install_lock/owner.pid"
    rmdir "$install_lock" 2>/dev/null || true
  fi
  if [[ -n "$package_tmp" ]]; then rm -rf -- "$package_tmp"; fi
  return "$status"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

# Serialize before touching the shared checkout's node_modules/dist as well as the destination.
# A dead PID record is recoverable; an active or malformed/symlinked lock fails closed.
share_root="$prefix/share/koni"
versions_root="$share_root/versions"
mkdir -p "$prefix/bin" "$versions_root"
lock_path="$share_root/.install.lock"
if ! mkdir "$lock_path" 2>/dev/null; then
  if [[ -d "$lock_path" && ! -L "$lock_path" && -f "$lock_path/owner.pid" && ! -L "$lock_path/owner.pid" ]]; then
    lock_pid="$(tr -d '\r\n' < "$lock_path/owner.pid")"
    if [[ "$lock_pid" =~ ^[1-9][0-9]*$ ]] && ! kill -0 "$lock_pid" 2>/dev/null; then
      stale_lock="$share_root/.install.lock.stale.$$"
      mv "$lock_path" "$stale_lock"
      rm -rf -- "$stale_lock"
      mkdir "$lock_path"
    else
      echo "Another Koni install is active, or its PID record needs review: $lock_path" >&2
      exit 1
    fi
  else
    echo "Koni install lock is malformed or symlinked and needs review: $lock_path" >&2
    exit 1
  fi
fi
printf '%s\n' "$$" > "$lock_path/owner.pid"
install_lock="$lock_path"
activation_journal="$share_root/activation-journal.json"
if [[ -e "$activation_journal" || -L "$activation_journal" ]]; then
  echo "Recovering the previous interrupted Koni activation." >&2
  node "$repo_root/scripts/register-dev-packages.mjs" rollback "$activation_journal" "$prefix/bin/koni"
fi

package_tmp="$(mktemp -d "${TMPDIR:-/tmp}/koni-packages.XXXXXX")"

(
  cd "$repo_root"
  npm ci
  npm run check
  npm run build
  npm pack --workspace @koni/coding-profile --pack-destination "$package_tmp" >/dev/null
  npm pack --workspace @koni/research-profile --pack-destination "$package_tmp" >/dev/null
  npm pack --workspace @koni/core --pack-destination "$package_tmp" >/dev/null
)

packages=()
while IFS= read -r package; do
  packages+=("$package")
done < <(find "$package_tmp" -maxdepth 1 -type f -name '*.tgz' -print | sort)
if [[ "${#packages[@]}" -ne 3 ]]; then
  echo "Expected exactly the Core, Coding, and Research package archives." >&2
  exit 1
fi

bundle_id="$(node -e '
  const { createHash } = require("node:crypto");
  const { readFileSync } = require("node:fs");
  const hash = createHash("sha256");
  for (const file of process.argv.slice(1).sort()) hash.update(readFileSync(file));
  process.stdout.write(hash.digest("hex"));
' "${packages[@]}")"
version_root="$versions_root/$bundle_id"
package_root="$version_root/package-root"
if [[ -e "$version_root" || -L "$version_root" ]]; then
  if [[ -L "$version_root" ]]; then
    echo "Refusing a symlinked Koni version root: $version_root" >&2
    exit 1
  fi
  node "$repo_root/scripts/dev-package-bundle.mjs" verify "$package_root" "$bundle_id"
else
  staged_version="$(mktemp -d "$versions_root/.${bundle_id}.stage.XXXXXX")"
  staged_root="$staged_version/package-root"
  mkdir "$staged_root"

  # Materialize only Koni and its ordinary runtime dependencies. Pi's package loader supplies all
  # @earendil-works/pi-* and TypeBox peers from the user's active Pi installation.
  npm install \
    --prefix "$staged_root" \
    --no-package-lock \
    --no-audit \
    --no-fund \
    --ignore-scripts \
    --omit=dev \
    --legacy-peer-deps \
    "${packages[@]}" >/dev/null

  # npm-created command links are not part of the runtime closure and would make the sealed tree
  # depend on symlink behavior. The explicit prefix/bin launcher is activated separately below.
  rm -rf -- "$staged_root/node_modules/.bin"
  node "$repo_root/scripts/dev-package-bundle.mjs" seal "$staged_root" "$bundle_id"
  node "$repo_root/scripts/dev-package-bundle.mjs" verify "$staged_root" "$bundle_id"
  node -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$staged_version" "$version_root"
  staged_version=""
  node "$repo_root/scripts/dev-package-bundle.mjs" verify "$package_root" "$bundle_id"
fi

package_roots=()
for package_path in core coding-profile research-profile; do
  package_roots+=("$package_root/node_modules/@koni/$package_path")
done

# Prove the sealed closure and launcher before changing either Pi settings or prefix/bin/koni.
candidate_launcher="$package_root/node_modules/@koni/core/bin/koni.js"
test "$("$candidate_launcher" --version)" = "$(node -p 'require(process.argv[1]).version' "$repo_root/packages/core/package.json")"
"$candidate_launcher" --help | grep -q '^Usage:'
preflight_project="$package_tmp/preflight-project"
mkdir "$preflight_project"
git -C "$preflight_project" init -q
"$candidate_launcher" init coding --root "$preflight_project" >/dev/null
"$candidate_launcher" config validate --root "$preflight_project" --json >/dev/null

# Activation is recoverable across both ordinary failures and process crashes. The journal stores
# only Koni-owned package entries plus an authenticated launcher snapshot; old versioned package
# bytes are deliberately retained for already-running authorities.
node "$repo_root/scripts/register-dev-packages.mjs" \
  activate "$activation_journal" "$prefix/bin/koni" "$candidate_launcher" "${package_roots[@]}"
launcher="$prefix/bin/.koni.$$.new"
ln -s "$candidate_launcher" "$launcher"
mv -f "$launcher" "$prefix/bin/koni"

test "$("$prefix/bin/koni" --version)" = "$(node -p 'require(process.argv[1]).version' "$repo_root/packages/core/package.json")"
"$prefix/bin/koni" --help | grep -q '^Usage:'
smoke_project="$package_tmp/project-smoke"
mkdir "$smoke_project"
git -C "$smoke_project" init -q
"$prefix/bin/koni" init coding --root "$smoke_project" >/dev/null
"$prefix/bin/koni" config validate --root "$smoke_project" --json >/dev/null
test -f "$smoke_project/.koni/project.yaml"
node "$repo_root/scripts/register-dev-packages.mjs" commit "$activation_journal" "$prefix/bin/koni"

echo "Installed @koni/core, @koni/coding-profile, and @koni/research-profile under $prefix"
echo "Registered the three Koni packages with Pi; existing authentication, settings, and resources were preserved."
bash "$repo_root/scripts/report-koni-path.sh" "$prefix"
