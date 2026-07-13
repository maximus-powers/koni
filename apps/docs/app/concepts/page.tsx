import type { Metadata } from "next";
import Link from "next/link";
import { GraphPlayground } from "@/components/graph-playground";
import { PageHero } from "@/components/page-hero";
import { RuntimeVisualizer } from "@/components/runtime-visualizer";
import { ArrowIcon } from "@/lib/icons";

export const metadata: Metadata = {
  title: "Concepts",
  description: "The mental model behind Köni: semantic graphs, deterministic compilation, isolated execution, and receipts.",
  alternates: { canonical: "/concepts" },
};

export default function ConceptsPage() {
  return (
    <>
      <PageHero
        eyebrow="Concepts · Mental model"
        title={<>The plan is a graph.<br /><em>The run is a proof.</em></>}
        description="Köni separates what the project means from how agents change it. The result is a system that can be creative without becoming opaque."
        aside={<div className="concept-formula"><span>intent</span><i>→</i><span>graph</span><i>→</i><span>gaps</span><i>→</i><strong>proof</strong></div>}
      />

      <section className="section shell concept-intro">
        <span className="eyebrow">Why Königsberg?</span>
        <div>
          <h2>A route problem becomes tractable when you model the structure.</h2>
          <p>The Königsberg bridge problem was not solved by trying harder routes. Euler represented land masses as nodes and bridges as edges, revealing the invariant underneath the maze. Köni applies the same move to agentic work: model the project state, then reason over its topology.</p>
        </div>
      </section>

      <section className="section shell">
        <GraphPlayground />
      </section>

      <section className="section shell concept-pillars">
        <article>
          <span>01 · Semantic plane</span>
          <h2>Nodes say what can be true.</h2>
          <p>A node is a meaningful project artifact or state: a requirement, contract, implementation, test result, or research conclusion. Edges describe valid relationships between them.</p>
          <div className="mini-diagram"><b>requirement</b><i>specifies</i><b>contract</b><i>verified by</i><b>check</b></div>
        </article>
        <article>
          <span>02 · Compiler</span>
          <h2>Rules say what must be true.</h2>
          <p>Rules query the graph for gaps. A missing relationship compiles into a ticket with exact context and dependencies. Scheduling is deterministic even when execution is creative.</p>
          <div className="query-card"><code>when: contract.missing(verification)</code><code>emit: verification_ticket</code></div>
        </article>
        <article>
          <span>03 · Runtime</span>
          <h2>Receipts say what became true.</h2>
          <p>Agents work in isolated Git worktrees. Actions, checks, outputs, reviews, and state transitions are journaled. A successful claim is not enough; the configured evidence gate must pass.</p>
          <div className="receipt-card"><i>✓</i><div><strong>verification passed</strong><span>tree 4bd91a · 3 checks · 18s</span></div></div>
        </article>
      </section>

      <section className="section runtime-concepts">
        <div className="shell">
          <div className="section-heading split-heading">
            <div><span className="eyebrow">Run lifecycle</span><h2>Human judgment at<br />the consequential edge.</h2></div>
            <p>Köni makes the approval boundary explicit, then supervises restart-safe automatic stages until work concludes or needs attention.</p>
          </div>
          <RuntimeVisualizer />
        </div>
      </section>

      <section className="section shell separation-grid">
        <div className="separation-head"><span className="eyebrow">The useful separation</span><h2>Give each kind of intelligence the right job.</h2></div>
        <div className="separation-card machine"><span>DETERMINISTIC</span><h3>Köni owns</h3><ul><li>Compilation and ordering</li><li>State and transitions</li><li>Permissions and isolation</li><li>Checks and receipts</li><li>Git integration</li></ul></div>
        <div className="separation-card agent"><span>GENERATIVE</span><h3>Agents own</h3><ul><li>Interpretation and design</li><li>Implementation choices</li><li>Investigation and synthesis</li><li>Risk discovery</li><li>Review judgment</li></ul></div>
      </section>

      <section className="guide-next shell concept-next">
        <span>Put the model to work</span>
        <h2>Shape Köni around your domain.</h2>
        <p>Configure the graph, run types, agents, and evidence your project needs.</p>
        <Link href="/configuration">Explore configuration <ArrowIcon /></Link>
      </section>
    </>
  );
}
