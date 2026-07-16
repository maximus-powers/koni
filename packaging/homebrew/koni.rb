# typed: strict
# frozen_string_literal: true

# Homebrew formula for the Köni command-line control plane.
class Koni < Formula
  desc "Graph-compiled control plane for reliable agentic work"
  homepage "https://github.com/maximus-powers/koni"
  license "MIT"
  head "https://github.com/maximus-powers/koni.git", branch: "main"

  depends_on "rust" => :build
  on_linux do
    depends_on "bubblewrap"
  end

  resource "node-runtime" do
    on_macos do
      on_arm do
        url "https://nodejs.org/dist/v22.19.0/node-v22.19.0-darwin-arm64.tar.xz"
        sha256 "1c3a9e78da501bbc1f0c99fbbb69bb7c722bc7a9bf30128b21ea502f3905892a"
      end
      on_intel do
        url "https://nodejs.org/dist/v22.19.0/node-v22.19.0-darwin-x64.tar.xz"
        sha256 "41796082f45db51738d1902cae84fa4f699ff6d2550321361424e8bfe6ea1939"
      end
    end
    on_linux do
      on_arm do
        url "https://nodejs.org/dist/v22.19.0/node-v22.19.0-linux-arm64.tar.xz"
        sha256 "0b2d9f564b6594222a62c82e1df2efe119dd4a4aff29644f4dd325bf360b6bcc"
      end
      on_intel do
        url "https://nodejs.org/dist/v22.19.0/node-v22.19.0-linux-x64.tar.xz"
        sha256 "c0649af18e6a24f6fe5535a3e86b341dd49a8e71117c8b68bde973ef834f16f2"
      end
    end
  end

  resource "npm-build" do
    url "https://registry.npmjs.org/npm/-/npm-11.13.0.tgz"
    sha256 "a4ffa1de3bf1c7f9d5e3dd24fe2921970bdb1589d647f4083eaaaab3be974b7e"
  end

  def install
    node_stage = buildpath/"node-runtime"
    resource("node-runtime").stage node_stage
    node_root = node_stage
    node = node_root/"bin/node"
    npm_stage = buildpath/"npm-build"
    resource("npm-build").stage npm_stage
    npm_cli = npm_stage/"bin/npm-cli.js"
    ENV["KONI_PINNED_NODE_PATH"] = node.realpath.to_s
    ENV["KONI_PINNED_BWRAP_PATH"] = (formula_opt_bin("bubblewrap")/"bwrap").realpath.to_s if OS.linux?

    sbom_path = buildpath/"koni-pi-host.cdx.json"
    cd "runtime/pi-host" do
      system node, npm_cli, "ci"
      system node, npm_cli, "run", "check"
      sbom = Utils.safe_popen_read(
        node.to_s, npm_cli.to_s, "sbom", "--omit=dev", "--sbom-format", "cyclonedx"
      )
      components = JSON.parse(sbom).fetch("components", [])
      expected_pi = {
        "@earendil-works/pi-agent-core" => "0.80.7",
        "@earendil-works/pi-ai"         => "0.80.7",
      }
      valid_sbom = expected_pi.all? do |name, version|
        components.any? { |component| component["name"] == name && component["version"] == version }
      end
      odie "Pi host SBOM does not contain the pinned production SDK closure" unless valid_sbom
      sbom_path.write(sbom)
    end
    system "cargo", "install", *std_cargo_args(path: "crates/koni-cli")

    (libexec/"koni/pi-host").install(
      "runtime/pi-host/dist/koni-pi-host.mjs",
      "runtime/pi-host/dist/koni-pi-host.sha256",
      sbom_path,
    )
    (libexec/"koni/pi-runtime").install node => "node"
    (libexec/"koni/pi-runtime").install formula_opt_bin("bubblewrap")/"bwrap" => "bwrap" if OS.linux?
    (pkgshare/"licenses").install "LICENSE" => "Koni-LICENSE", node_root/"LICENSE" => "Node-LICENSE"
  end

  test do
    project = testpath/"project"
    project.mkpath
    system "git", "-C", project, "init", "-q"
    system bin/"koni", "init", "--profile", "software", "--target", project
    assert_path_exists project/".koni/project.yaml"
    assert_path_exists project/".agents/skills/configure-koni/SKILL.md"
    assert_match(/^koni \d+\.\d+\.\d+/, shell_output("#{bin}/koni --version"))
    assert_match(/"runtime": "pi-sdk"/, shell_output("#{bin}/koni models --json"))
  end
end
