import Link from "next/link";
import { BridgeHero } from "@/components/bridge-hero";
import { CodeBlock } from "@/components/code-block";
import { ConfigStack } from "@/components/config-stack";
import { GraphPlayground } from "@/components/graph-playground";
import { RuntimeVisualizer } from "@/components/runtime-visualizer";
import { principles } from "@/content/site";
import { ArrowIcon } from "@/lib/icons";

const quickstart = `# Install from source today
cargo install --git https://github.com/maximus-powers/koni koni-cli

# Add Köni to this project
koni init

# Open the control center
koni`;

export default function HomePage() {
  return (
    <>
      <section className="home-hero shell">
        <div className="home-hero-copy">
          <div className="status-chip"><i />Open source · early access</div>
          <h1>Make agent work<br /><em>traversable.</em></h1>
          <p>
            Köni turns intent into a semantic graph, compiles its gaps into bounded work,
            and carries every change across reviewable bridges.
          </p>
          <div className="hero-actions">
            <Link className="button button-primary" href="/get-started">Initialize a project <ArrowIcon /></Link>
            <Link className="button button-ghost" href="/concepts">Explore the model</Link>
          </div>
          <div className="hero-note"><span>Built for</span><strong>Codex</strong><span>·</span><strong>Git</strong><span>·</span><strong>your repository</strong></div>
        </div>
        <BridgeHero />
      </section>

      <section className="signal-strip" aria-label="Köni product characteristics">
        <div className="shell">
          <span>GRAPH-FIRST</span><i />
          <span>PROJECT-LOCAL</span><i />
          <span>RECEIPT-BOUND</span><i />
          <span>HUMAN-APPROVED</span>
        </div>
      </section>

      <section className="section shell">
        <div className="section-heading split-heading">
          <div><span className="eyebrow">The core loop</span><h2>From an open question<br />to verified state.</h2></div>
          <p>Köni keeps the agent creative and the system deterministic. Select each stage to see where one ends and the other begins.</p>
        </div>
        <GraphPlayground />
      </section>

      <section className="section principle-section">
        <div className="shell">
          <div className="section-heading"><span className="eyebrow">A different operating model</span><h2>Structure is the strategy.</h2></div>
          <div className="principle-grid">
            {principles.map((principle) => (
              <article className="principle-card" key={principle.number}>
                <span>{principle.number}</span>
                <h3>{principle.title}</h3>
                <p>{principle.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section shell configure-preview">
        <div className="configure-copy">
          <span className="eyebrow">Project-local by design</span>
          <h2>Your framework lives beside your work.</h2>
          <p>
            <code>koni init</code> installs a complete, inspectable model into the project.
            Codex can shape it from natural language; the TUI gives you a precise final pass.
          </p>
          <Link className="text-link" href="/configuration">See the configuration model <ArrowIcon /></Link>
        </div>
        <ConfigStack />
      </section>

      <section className="section runtime-preview shell">
        <div className="section-heading split-heading">
          <div><span className="eyebrow">A controlled runtime</span><h2>Every crossing has<br />a visible boundary.</h2></div>
          <p>Planning, approval, execution, verification, and integration are durable stages—not vibes hidden inside an agent transcript.</p>
        </div>
        <RuntimeVisualizer />
      </section>

      <section className="section shell start-panel">
        <div className="start-copy">
          <span className="eyebrow">Start with one repository</span>
          <h2>A control plane in three commands.</h2>
          <p>Köni discovers the project root, installs its configuration safely, and opens the same engine for people and automation.</p>
          <div className="availability-note"><i />The Homebrew formula is being prepared. It is not published yet.</div>
        </div>
        <CodeBlock code={quickstart} label="Quickstart" language="shell" />
      </section>

      <section className="closing-cta shell">
        <span className="eyebrow">The graph is yours</span>
        <h2>Describe the outcome.<br />Köni will map the crossing.</h2>
        <div>
          <Link className="button button-light" href="/get-started">Get started <ArrowIcon /></Link>
          <a className="button button-dark" href="https://github.com/maximus-powers/koni">View on GitHub</a>
        </div>
      </section>
    </>
  );
}
