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

const install = `pi install npm:@koni/core
pi install npm:@koni/coding-profile
export PATH="\${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/npm/node_modules/.bin:$PATH"
koni --version`;
const initialize = `cd path/to/your-project
git init  # only if this is a brand-new directory
koni init coding`;
const launch = `# Standalone control center
koni tui

# Or, from an interactive Pi session
/koni`;

export default function GetStartedPage() {
  return (
    <>
      <PageHero
        eyebrow="Get started · 5 minutes"
        title={<>Give one project<br /><em>a control plane.</em></>}
        description="Köni is a Pi-native package system with one authoritative project model. Install Core and a profile, initialize, inspect, then plan your first run."
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
            <div className="step-label"><span>01</span>Install the Pi packages</div>
            <h2>Core plus the profile you need.</h2>
            <p>Pi loads Köni’s extension and profile as normal packages. That same Pi-managed Core closure exposes <code>koni tui</code> through its <code>.bin</code> directory; it never creates panes or reads/copies Pi credentials. Installation adds or replaces only Köni-owned package entries and preserves every unrelated setting and resource.</p>
            <CodeBlock code={install} label="Terminal" language="shell" />
            <div className="callout callout-note"><strong>Already use Pi?</strong><p>Your providers, OAuth credentials, skills, prompts, and interactive extensions remain yours. Köni only seals the resources supplied to autonomous attempts.</p></div>
          </section>

          <section id="initialize" className="guide-section">
            <div className="step-label"><span>02</span>Initialize a project</div>
            <h2>Run init from anywhere inside it.</h2>
            <p>Köni discovers the enclosing Git worktree root. A brand-new directory needs <code>git init</code> first because branches, worktrees, durable authority state, and merge targets are part of every Koni project. Initialization itself creates no run or commit.</p>
            <CodeBlock code={initialize} label="Terminal" language="shell" />
            <div className="result-card">
              <div className="result-head"><span>Created safely</span><code>your-project/</code></div>
              <pre>{`.koni/
├── project.yaml        # selected profile and project overlay
├── graph/              # typed nodes and relationships
├── run-types/          # Small, Medium, Large, and custom flows
├── agents/             # personas and model policy
└── .managed/           # baselines, receipts, migrations
.git/koni/                 # common-dir authority and durable run state`}</pre>
              <p>Existing Pi resources are preserved. Köni tracks the profile baseline separately from the project overlay and refuses ambiguous overwrites.</p>
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
            <p>Ask Pi to adapt the profile in plain language—“add a UI Feature run type with screenshot verification”—then use the Configure screen for the final touch.</p>
          </section>

          <section id="first-run" className="guide-section">
            <div className="step-label"><span>04</span>Plan your first run</div>
            <h2>Open the shared control center.</h2>
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
