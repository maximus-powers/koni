"use client";

import { useState } from "react";

const views = [
  {
    id: "intent",
    tab: "01 · Intent",
    kicker: "Describe the destination",
    title: "Start with states that matter.",
    body: "A goal becomes a small semantic graph: what is true now, what must become true, and which relationships constrain the crossing.",
    status: "4 states · 5 relations",
  },
  {
    id: "compile",
    tab: "02 · Compile",
    kicker: "Find the missing crossings",
    title: "Turn gaps into bounded tickets.",
    body: "Rules inspect the graph deterministically. Every missing edge becomes explicit work with context, dependencies, and a clear completion condition.",
    status: "3 tickets · 1 gate",
  },
  {
    id: "execute",
    tab: "03 · Verify",
    kicker: "Cross with evidence",
    title: "Accept receipts, not claims.",
    body: "Agents do the creative work in isolated worktrees. Checks decide what can advance; journals and receipts preserve how it happened.",
    status: "3 receipts · verified",
  },
] as const;

export function GraphPlayground() {
  const [active, setActive] = useState(0);
  const view = views[active];

  return (
    <section className="graph-playground" aria-labelledby="graph-playground-title">
      <div className="graph-tabs" role="tablist" aria-label="Köni workflow stages">
        {views.map((item, index) => (
          <button
            key={item.id}
            id={`graph-tab-${item.id}`}
            role="tab"
            aria-selected={active === index}
            aria-controls={`graph-panel-${item.id}`}
            onClick={() => setActive(index)}
            type="button"
          >
            {item.tab}
          </button>
        ))}
      </div>
      <div className="graph-stage">
        <div
          className="graph-copy"
          id={`graph-panel-${view.id}`}
          role="tabpanel"
          aria-labelledby={`graph-tab-${view.id}`}
        >
          <span>{view.kicker}</span>
          <h2 id="graph-playground-title">{view.title}</h2>
          <p>{view.body}</p>
          <div className="graph-status"><i />{view.status}</div>
        </div>
        <div className={`graph-canvas graph-state-${view.id}`} aria-hidden="true">
          <svg viewBox="0 0 620 380">
            <defs>
              <pattern id="dot-grid" width="24" height="24" patternUnits="userSpaceOnUse">
                <circle cx="1" cy="1" r="1" fill="currentColor" opacity=".16" />
              </pattern>
              <filter id="node-glow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="7" result="blur" />
                <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
              </filter>
            </defs>
            <rect className="graph-grid" width="620" height="380" fill="url(#dot-grid)" />
            <path className="river river-a" d="M0 114c112-42 195 42 305 2s187-5 315 2" />
            <path className="river river-b" d="M0 262c94-30 170 27 273-5s224 39 347-9" />
            <path className="edge edge-1" d="M92 75C158 78 164 155 229 164" />
            <path className="edge edge-2" d="M229 164C289 158 300 83 373 78" />
            <path className="edge edge-3" d="M229 164C282 199 277 287 345 302" />
            <path className="edge edge-4" d="M373 78C411 126 437 184 491 197" />
            <path className="edge edge-5" d="M345 302C410 292 418 221 491 197" />
            <path className="edge edge-ticket" d="M92 75C187 11 300 19 373 78" />
            <g className="node node-1" transform="translate(92 75)"><circle r="25" /><circle className="node-core" r="7" /><text y="46">intent</text></g>
            <g className="node node-2" transform="translate(229 164)"><circle r="25" /><circle className="node-core" r="7" /><text y="46">plan</text></g>
            <g className="node node-3" transform="translate(373 78)"><circle r="25" /><circle className="node-core" r="7" /><text y="46">contract</text></g>
            <g className="node node-4" transform="translate(345 302)"><circle r="25" /><circle className="node-core" r="7" /><text y="46">change</text></g>
            <g className="node node-5" transform="translate(491 197)"><circle r="28" filter="url(#node-glow)" /><circle className="node-core" r="8" /><text y="49">verified</text></g>
            <g className="ticket-label" transform="translate(210 26)"><rect width="112" height="31" rx="15.5" /><text x="56" y="20">ticket · K-014</text></g>
            <g className="receipt-label" transform="translate(440 282)"><rect width="119" height="31" rx="15.5" /><text x="59.5" y="20">receipt · pass</text></g>
          </svg>
          <div className="canvas-label"><span>PROJECT GRAPH</span><span>LIVE PROJECTION</span></div>
        </div>
      </div>
    </section>
  );
}
