import type { Metadata } from "next";
import Link from "next/link";
import { CodeBlock } from "@/components/code-block";
import { PageHero } from "@/components/page-hero";
import { ArrowIcon } from "@/lib/icons";

export const metadata: Metadata = {
  title: "Get started",
  description: "Install Köni, initialize a project, and create your first graph-compiled run.",
  alternates: { canonical: "/get-started" },
};

const install = `cargo install --git https://github.com/maximus-powers/koni koni-cli
koni --version`;
const initialize = `cd path/to/your-project
koni init`;
const launch = `koni`;

export default function GetStartedPage() {
  return (
    <>
      <PageHero
        eyebrow="Get started · 5 minutes"
        title={<>Give one project<br /><em>a control plane.</em></>}
        description="Köni installs one global executable and keeps the model for each project in that project. Initialize, inspect, then plan your first run."
        aside={<div className="terminal-mini"><div><i /><i /><i /><span>koni — project</span></div><pre><span>◆</span> profile     software{"\n"}<span>◆</span> run type    medium{"\n"}<span>◇</span> state       ready{"\n\n"}<strong>n</strong> new run   <strong>c</strong> configure</pre></div>}
      />

      <div className="guide-layout shell">
        <aside className="guide-toc">
          <span>On this page</span>
          <a href="#install">1. Install</a>
          <a href="#initialize">2. Initialize</a>
          <a href="#inspect">3. Inspect</a>
          <a href="#first-run">4. First run</a>
          <a href="#next">Next steps</a>
        </aside>
        <article className="guide-content">
          <section id="install" className="guide-section">
            <div className="step-label"><span>01</span>Install the executable</div>
            <h2>One binary, available everywhere.</h2>
            <p>Until the Homebrew formula is published, install directly from the public repository with Cargo. The binary contains the engine, TUI, schemas, profiles, and project templates.</p>
            <CodeBlock code={install} label="Terminal" language="shell" />
            <div className="callout callout-note"><strong>Homebrew is coming.</strong><p><code>brew install koni</code> is the intended release path, but the formula is not live yet.</p></div>
          </section>

          <section id="initialize" className="guide-section">
            <div className="step-label"><span>02</span>Initialize a project</div>
            <h2>Run init from anywhere inside it.</h2>
            <p>Köni discovers the Git worktree root. If the directory is not yet a Git repository, it uses the current directory without creating a run or initializing Git.</p>
            <CodeBlock code={initialize} label="Terminal" language="shell" />
            <div className="result-card">
              <div className="result-head"><span>Created safely</span><code>your-project/</code></div>
              <pre>{`.codex/
├── koni/              # catalog, profile, graph, rules
├── agents/            # native Codex agent roles
└── config.toml        # project Codex settings
.agents/
└── skills/            # configure, model, operate Köni`}</pre>
              <p>Existing Codex resources are preserved. Köni tracks the files it owns and refuses ambiguous overwrites.</p>
            </div>
          </section>

          <section id="inspect" className="guide-section">
            <div className="step-label"><span>03</span>Inspect the model</div>
            <h2>The default is useful, not magical.</h2>
            <p>The software profile includes Small, Medium, and Large run types. Each is a complete peer with its own planning depth, question policy, agent assignments, and parallelism.</p>
            <div className="size-grid">
              <div><span>S</span><strong>Small</strong><p>Direct, conservative work. One ticket at a time.</p></div>
              <div className="recommended"><i>default</i><span>M</span><strong>Medium</strong><p>Combined planning with bounded parallel execution.</p></div>
              <div><span>L</span><strong>Large</strong><p>Separate architecture, risk, and verification passes.</p></div>
            </div>
            <p>Ask Codex to adapt the profile in plain language—“add a UI Feature run type with screenshot verification”—then use the Configure screen for the final touch.</p>
          </section>

          <section id="first-run" className="guide-section">
            <div className="step-label"><span>04</span>Plan your first run</div>
            <h2>Open the control center.</h2>
            <CodeBlock code={launch} label="Terminal" language="shell" />
            <ol className="number-list">
              <li><span>1</span><div><strong>Press <kbd>n</kbd> for a new run.</strong><p>Choose a run type and describe the outcome you want.</p></div></li>
              <li><span>2</span><div><strong>Review the compiled plan.</strong><p>Köni pins the resolved configuration and shows high-impact questions.</p></div></li>
              <li><span>3</span><div><strong>Approve explicitly.</strong><p>Only then does Köni create the run branch and begin supervised work.</p></div></li>
            </ol>
          </section>

          <section id="next" className="guide-next">
            <span>Next crossing</span>
            <h2>Understand the graph model.</h2>
            <p>Learn why Köni models state before it schedules work.</p>
            <Link href="/concepts">Read Concepts <ArrowIcon /></Link>
          </section>
        </article>
      </div>
    </>
  );
}
