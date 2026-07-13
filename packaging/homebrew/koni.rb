# typed: strict
# frozen_string_literal: true

# Homebrew formula for the Köni command-line control plane.
class Koni < Formula
  desc "Graph-compiled control plane for reliable agentic work"
  homepage "https://github.com/maximus-powers/koni"
  license "MIT"
  head "https://github.com/maximus-powers/koni.git", branch: "main"

  depends_on "rust" => :build

  def install
    system "cargo", "install", *std_cargo_args(path: "crates/koni-cli")
  end

  test do
    project = testpath/"project"
    project.mkpath
    system "git", "-C", project, "init", "-q"
    system bin/"koni", "init", "--target", project
    assert_path_exists project/".codex/koni/project.yaml"
    assert_path_exists project/".agents/skills/configure-koni/SKILL.md"
    assert_match(/^koni \d+\.\d+\.\d+/, shell_output("#{bin}/koni --version"))
  end
end
