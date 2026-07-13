import type { Metadata } from "next";
import { CodeBlock } from "@/components/code-block";
import { PageHero } from "@/components/page-hero";

export const metadata: Metadata = {
  title: "CLI",
  description: "Köni command-line reference for project initialization, validation, planning, approval, and inspection.",
  alternates: { canonical: "/cli" },
};

const commands = [
  { command: "koni", description: "Discover the current project and open its terminal control center." },
  { command: "koni init", description: "Install Köni configuration, native agents, and skills into a project." },
  { command: "koni validate", description: "Compile and validate the project’s resolved model without starting a run." },
  { command: "koni plan-run", description: "Resolve a run type, capture intake, and perform the safe planning prefix." },
  { command: "koni approve-run", description: "Approve a pinned plan and create its permanent isolated run." },
  { command: "koni cockpit", description: "Print the current control-center projection; add --json for automation." },
] as const;

export default function CliPage() {
  return (
    <>
      <PageHero
        eyebrow="CLI · Command reference"
        title={<>One engine.<br /><em>Human or scripted.</em></>}
        description="The TUI and CLI expose the same compiled model. Work interactively, automate durable transitions, or inspect state as JSON."
        aside={<div className="cli-hero-aside"><code>$ koni</code><span>◆ project ready</span><span>◇ 2 runs active</span><span>✓ profile valid</span></div>}
      />

      <div className="guide-layout shell cli-guide">
        <aside className="guide-toc">
          <span>CLI reference</span>
          <a href="#commands">Commands</a>
          <a href="#init">Initialize</a>
          <a href="#runs">Runs</a>
          <a href="#output">Automation</a>
          <a href="#global">Common options</a>
        </aside>
        <article className="guide-content">
          <section id="commands" className="guide-section">
            <div className="step-label"><span>00</span>Command map</div>
            <h2>The short path to every surface.</h2>
            <div className="command-list">
              {commands.map((item) => (
                <div key={item.command}><code>{item.command}</code><p>{item.description}</p></div>
              ))}
            </div>
          </section>

          <section id="init" className="guide-section">
            <div className="step-label"><span>01</span>Initialize</div>
            <h2>Install a project model safely.</h2>
            <CodeBlock code={`koni init [OPTIONS]\n\n  --target <PATH>       Initialize an exact directory\n  --profile <PROFILE>   software | research\n  --from <PATH>         Install a profile from a directory\n  --dry-run             Show changes without writing\n  --replace             Replace owned Köni resources\n  --open                Open the TUI after success`} label="Usage" />
            <p>Without <code>--target</code>, Köni finds the enclosing Git worktree root. Re-running init is idempotent. Modified or unowned resources are never silently replaced.</p>
            <div className="callout callout-note"><strong>Legacy project?</strong><p>If Köni finds <code>.codex/pythagoras/</code> and no new layout, init offers an atomic migration with a byte-for-byte backup.</p></div>
          </section>

          <section id="runs" className="guide-section">
            <div className="step-label"><span>02</span>Plan and approve</div>
            <h2>Keep intent separate from mutation.</h2>
            <CodeBlock code={`PLAN=$(koni plan-run \\\n  --root . \\\n  --goal "Add passkey sign-in" \\\n  --run-type medium)\n\nRUN_ID=$(printf '%s' "$PLAN" | jq -r .run_id)\nkoni approve-run "$RUN_ID" --root .`} label="Terminal" language="shell" />
            <p><code>plan-run</code> resolves and hashes every input before it creates consequential state. <code>approve-run</code> verifies those pins, creates the integration branch/worktree, and starts supervised stages.</p>
          </section>

          <section id="output" className="guide-section">
            <div className="step-label"><span>03</span>Automation output</div>
            <h2>Project the control plane as JSON.</h2>
            <CodeBlock code={`koni --run "$RUN_ID" cockpit . --json | jq '{\n  state: .run.state,\n  ready: [.tickets[] | select(.state == "ready") | .id],\n  blocked: [.questions[] | select(.status == "open") | .id]\n}'`} label="Terminal" language="shell" />
            <p>JSON output is designed for scripts and external loops. Durable IDs, states, receipts, and questions are safer integration points than scraping terminal text.</p>
          </section>

          <section id="global" className="guide-section">
            <div className="step-label"><span>04</span>Common options</div>
            <h2>Address targets explicitly.</h2>
            <div className="option-table" role="table" aria-label="Common CLI options">
              <div role="row"><code role="cell">--run &lt;ID&gt;</code><span role="cell">Global selector for one durable run without changing the selection pointer.</span></div>
              <div role="row"><code role="cell">--root &lt;PATH&gt;</code><span role="cell">Project root accepted by run and automation subcommands.</span></div>
              <div role="row"><code role="cell">--json</code><span role="cell">Emit structured output on commands that expose a JSON projection.</span></div>
              <div role="row"><code role="cell">--help</code><span role="cell">Show command-specific usage and options.</span></div>
              <div role="row"><code role="cell">--version</code><span role="cell">Print the installed Köni version.</span></div>
            </div>
          </section>

          <section className="cli-ending">
            <span>Need the visual surface?</span>
            <h2>Run <code>koni</code> with no subcommand.</h2>
            <p>The control center shows runs, tickets, graph state, questions, checks, and project configuration in one place.</p>
          </section>
        </article>
      </div>
    </>
  );
}
