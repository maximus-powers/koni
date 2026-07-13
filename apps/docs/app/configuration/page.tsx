import type { Metadata } from "next";
import Link from "next/link";
import { CodeBlock } from "@/components/code-block";
import { ConfigStack } from "@/components/config-stack";
import { PageHero } from "@/components/page-hero";
import { ArrowIcon } from "@/lib/icons";

export const metadata: Metadata = {
  title: "Configuration",
  description: "Configure Köni catalogs, run types, graph rules, agents, workflows, checks, and reports.",
  alternates: { canonical: "/configuration" },
};

const naturalLanguage = `Add a “UI Feature” run type based on Medium.
Use a design-mapper before implementation, allow up to
three workers, and require typecheck plus screenshot review.`;

const catalogExample = `schema: koni.project/v1
name: storefront
default_run_type: medium
profile: profile.yaml
run_types:
  - run-types/small.yaml
  - run-types/medium.yaml
  - run-types/large.yaml
  - run-types/ui-feature.yaml`;

const graphExample = `nodes:
  - id: interface_contract
    description: Observable UI behavior and states
  - id: implementation
    description: Code that satisfies the contract

edges:
  - id: implements
    from: implementation
    to: interface_contract`;

export default function ConfigurationPage() {
  return (
    <>
      <PageHero
        eyebrow="Configuration · Project model"
        title={<>Readable by people.<br /><em>Editable by agents.</em></>}
        description="Köni configuration is local, typed, and composable. Start from natural language, inspect the resulting YAML, then refine it in the control center."
        aside={<div className="config-hero-aside"><span>CONFIG SURFACE</span><strong>8</strong><small>typed primitive families</small><div><i /><i /><i /><i /><i /></div></div>}
      />

      <section className="section shell config-overview">
        <div className="section-heading split-heading">
          <div><span className="eyebrow">Four connected layers</span><h2>Configuration follows<br />ownership boundaries.</h2></div>
          <p>Köni owns its semantic model. Codex keeps its native agents and skills. Initialization connects them without hiding either system.</p>
        </div>
        <ConfigStack />
      </section>

      <section className="section agent-config-section">
        <div className="shell agent-config-grid">
          <div>
            <span className="eyebrow">The intended authoring loop</span>
            <h2>Describe. Validate. Touch up.</h2>
            <p>Project skills give Codex the full Köni vocabulary and invariants. Ask for behavior, not file edits; the agent can map your intent into a valid configuration transaction.</p>
            <CodeBlock code={naturalLanguage} label="Prompt to Codex" />
          </div>
          <ol className="authoring-steps">
            <li><span>1</span><div><strong>Describe the behavior</strong><p>Name the kind of work, desired rigor, agent roles, or evidence you care about.</p></div></li>
            <li><span>2</span><div><strong>Let Codex model it</strong><p>The installed skills explain schemas, relationships, safe defaults, and validation.</p></div></li>
            <li><span>3</span><div><strong>Review in Configure</strong><p>Open <kbd>c</kbd> in the TUI to inspect the complete resolved behavior.</p></div></li>
            <li><span>4</span><div><strong>Publish atomically</strong><p>Köni validates the draft before replacing the live project model.</p></div></li>
          </ol>
        </div>
      </section>

      <div className="guide-layout shell config-guide">
        <aside className="guide-toc">
          <span>Configuration</span>
          <a href="#catalog">Catalog</a>
          <a href="#run-types">Run types</a>
          <a href="#profile">Profile</a>
          <a href="#agents">Agents & skills</a>
          <a href="#validate">Validation</a>
        </aside>
        <article className="guide-content">
          <section id="catalog" className="guide-section">
            <div className="step-label"><span>01</span>Project catalog</div>
            <h2>The entry point.</h2>
            <p><code>project.yaml</code> identifies one semantic profile and a flat list of complete run types. One run selects one peer; Small, Medium, and Large do not layer over each other at runtime.</p>
            <CodeBlock code={catalogExample} label=".codex/koni/project.yaml" language="yaml" />
          </section>

          <section id="run-types" className="guide-section">
            <div className="step-label"><span>02</span>Run types</div>
            <h2>Complete operating policies.</h2>
            <p>A run type resolves everything that changes how one class of work runs: intake, planning passes, question policy, pipeline stages, Git naming, models, roles, and parallelism.</p>
            <div className="definition-grid">
              <div><span>intake</span><p>What the operator provides.</p></div><div><span>pipeline</span><p>Ordered run stages.</p></div>
              <div><span>questions</span><p>When agents may pause.</p></div><div><span>orchestration</span><p>Roles and parallelism.</p></div>
              <div><span>git</span><p>Branches and worktrees.</p></div><div><span>presentation</span><p>Run-card projection.</p></div>
            </div>
          </section>

          <section id="profile" className="guide-section">
            <div className="step-label"><span>03</span>Semantic profile</div>
            <h2>Your project’s vocabulary.</h2>
            <p>The profile imports typed primitive families. Graph nodes and edges define the state space; rules find gaps; workflows and actions determine how work may satisfy them.</p>
            <CodeBlock code={graphExample} label=".codex/koni/graph.yaml" language="yaml" />
            <div className="primitive-list">
              <div><strong>Graph</strong><span>nodes · edges · queries</span></div>
              <div><strong>Logic</strong><span>rules · gates · state machines</span></div>
              <div><strong>Work</strong><span>workflows · operations · actions</span></div>
              <div><strong>Evidence</strong><span>checks · reports · views</span></div>
            </div>
          </section>

          <section id="agents" className="guide-section">
            <div className="step-label"><span>04</span>Agents and skills</div>
            <h2>Roles resolve to native Codex resources.</h2>
            <p>Personas in the profile point to agent definitions in <code>.codex/agents/</code>. Those definitions own instructions, model policy, permissions, and skill references. Reusable Köni knowledge lives in <code>.agents/skills/</code> so it is available in ordinary Codex chats.</p>
            <div className="callout callout-warning"><strong>Keep least privilege local.</strong><p>Give each agent only the tools and write surface its role requires. A reviewer and an implementer should not have identical permissions.</p></div>
          </section>

          <section id="validate" className="guide-section">
            <div className="step-label"><span>05</span>Validation</div>
            <h2>Publish only coherent models.</h2>
            <p>Validation checks identifiers, references, cycles, paths, action effects, permissions, and installed resource hashes before a configuration is used.</p>
            <CodeBlock code={`koni validate-profile .\nkoni validate --root .\nkoni init --dry-run`} label="Terminal" language="shell" />
          </section>

          <section className="guide-next">
            <span>Use the same engine in automation</span>
            <h2>Meet the command line.</h2>
            <p>Initialize, validate, plan, inspect, and operate without opening the TUI.</p>
            <Link href="/cli">Read the CLI reference <ArrowIcon /></Link>
          </section>
        </article>
      </div>
    </>
  );
}
