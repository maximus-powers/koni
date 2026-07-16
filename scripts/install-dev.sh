#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
prefix="${KONI_INSTALL_PREFIX:-${HOME}/.local}"

node_version="22.19.0"
npm_version="11.13.0"
case "$(uname -s):$(uname -m)" in
  Darwin:arm64)
    node_platform="darwin-arm64"
    node_sha256="1c3a9e78da501bbc1f0c99fbbb69bb7c722bc7a9bf30128b21ea502f3905892a"
    ;;
  Darwin:x86_64)
    node_platform="darwin-x64"
    node_sha256="41796082f45db51738d1902cae84fa4f699ff6d2550321361424e8bfe6ea1939"
    ;;
  Linux:aarch64|Linux:arm64)
    node_platform="linux-arm64"
    node_sha256="0b2d9f564b6594222a62c82e1df2efe119dd4a4aff29644f4dd325bf360b6bcc"
    ;;
  Linux:x86_64|Linux:amd64)
    node_platform="linux-x64"
    node_sha256="c0649af18e6a24f6fe5535a3e86b341dd49a8e71117c8b68bde973ef834f16f2"
    ;;
  *)
    echo "Köni has no pinned Pi runtime for $(uname -s)/$(uname -m)." >&2
    exit 1
    ;;
esac

if ! command -v curl >/dev/null || ! command -v tar >/dev/null; then
  echo "Köni requires curl and tar to fetch the verified standalone Node runtime." >&2
  exit 1
fi

sha256_file() {
  if command -v sha256sum >/dev/null; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    echo "Köni requires sha256sum or shasum to verify runtime downloads." >&2
    return 1
  fi
}

runtime_tmp="$(mktemp -d "${TMPDIR:-/tmp}/koni-node-runtime.XXXXXX")"
trap 'rm -rf -- "$runtime_tmp"' EXIT
node_name="node-v${node_version}-${node_platform}"
node_archive="$runtime_tmp/${node_name}.tar.xz"
npm_archive="$runtime_tmp/npm-${npm_version}.tgz"
curl --fail --location --silent --show-error --retry 3 --retry-all-errors \
  "https://nodejs.org/dist/v${node_version}/${node_name}.tar.xz" -o "$node_archive"
curl --fail --location --silent --show-error --retry 3 --retry-all-errors \
  "https://registry.npmjs.org/npm/-/npm-${npm_version}.tgz" -o "$npm_archive"
if [[ "$(sha256_file "$node_archive")" != "$node_sha256" ]]; then
  echo "The downloaded Node ${node_version} archive failed SHA-256 verification." >&2
  exit 1
fi
if [[ "$(sha256_file "$npm_archive")" != "a4ffa1de3bf1c7f9d5e3dd24fe2921970bdb1589d647f4083eaaaab3be974b7e" ]]; then
  echo "The downloaded npm ${npm_version} archive failed SHA-256 verification." >&2
  exit 1
fi
tar -xJf "$node_archive" -C "$runtime_tmp"
tar -xzf "$npm_archive" -C "$runtime_tmp"
node_root="$runtime_tmp/$node_name"
node_path="$node_root/bin/node"
npm_cli="$runtime_tmp/package/bin/npm-cli.js"
[[ "$("$node_path" --version)" == "v${node_version}" ]]
[[ "$("$node_path" "$npm_cli" --version)" == "$npm_version" ]]
export KONI_PINNED_NODE_PATH="$node_path"

if [[ "$(uname -s)" == "Linux" ]]; then
  bwrap_candidate="${KONI_PINNED_BWRAP_PATH:-$(command -v bwrap || true)}"
  if [[ -z "$bwrap_candidate" ]]; then
    echo "Köni requires bubblewrap to build/install the Linux Pi runtime." >&2
    exit 1
  fi
  export KONI_PINNED_BWRAP_PATH
  KONI_PINNED_BWRAP_PATH="$("$node_path" -e 'console.log(require("fs").realpathSync(process.argv[1]))' "$bwrap_candidate")"
fi

(
  cd "$repo_root/runtime/pi-host"
  "$node_path" "$npm_cli" ci
  "$node_path" "$npm_cli" run check
  "$node_path" "$npm_cli" sbom --omit=dev --sbom-format cyclonedx > dist/koni-pi-host.cdx.json
  "$node_path" -e 'const b=require("./dist/koni-pi-host.cdx.json"); if (b.bomFormat !== "CycloneDX" || !b.components?.some((c) => c.name === "@earendil-works/pi-agent-core" && c.version === "0.80.7") || !b.components?.some((c) => c.name === "@earendil-works/pi-ai" && c.version === "0.80.7")) process.exit(1)'
)
(
  cd "$repo_root"
  cargo build --locked --release --package koni-cli
)

target_dir="${CARGO_TARGET_DIR:-$repo_root/target}"
if [[ "$target_dir" != /* ]]; then
  target_dir="$repo_root/$target_dir"
fi
install -d \
  "$prefix/bin" \
  "$prefix/libexec/koni/pi-host" \
  "$prefix/libexec/koni/pi-runtime" \
  "$prefix/share/doc/koni"
install -m 0755 "$target_dir/release/koni" "$prefix/bin/koni"
install -m 0755 \
  "$repo_root/runtime/pi-host/dist/koni-pi-host.mjs" \
  "$prefix/libexec/koni/pi-host/koni-pi-host.mjs"
install -m 0644 \
  "$repo_root/runtime/pi-host/dist/koni-pi-host.sha256" \
  "$prefix/libexec/koni/pi-host/koni-pi-host.sha256"
install -m 0644 \
  "$repo_root/runtime/pi-host/dist/koni-pi-host.cdx.json" \
  "$prefix/libexec/koni/pi-host/koni-pi-host.cdx.json"
install -m 0755 "$KONI_PINNED_NODE_PATH" "$prefix/libexec/koni/pi-runtime/node"
install -m 0644 "$repo_root/LICENSE" "$prefix/share/doc/koni/Koni-LICENSE"
install -m 0644 "$node_root/LICENSE" "$prefix/share/doc/koni/Node-LICENSE"
if [[ "$(uname -s)" == "Linux" ]]; then
  install -m 0755 "$KONI_PINNED_BWRAP_PATH" "$prefix/libexec/koni/pi-runtime/bwrap"
fi

"$prefix/bin/koni" --version
"$prefix/bin/koni" models --json >/dev/null
echo "Installed Köni and its verified Pi runtime under $prefix"
