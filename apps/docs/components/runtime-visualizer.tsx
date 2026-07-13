"use client";

import { useState } from "react";

const stages = [
  { label: "Plan", caption: "Resolve + pin", detail: "Köni resolves the chosen run type and profile, performs bounded planning, and pins every input by hash." },
  { label: "Approve", caption: "Human boundary", detail: "You review the plan before Köni creates a permanent run branch or begins consequential work." },
  { label: "Execute", caption: "Isolated agents", detail: "Tickets run in linked worktrees under explicit permissions, parallelism, checks, and retry policy." },
  { label: "Verify", caption: "Evidence gates", detail: "Configured checks produce receipts. Failed or blocked stages stay visible instead of being hand-waved away." },
  { label: "Integrate", caption: "Atomic result", detail: "Verified work is reviewed, checkpointed, and squash-integrated through a controlled Git transaction." },
] as const;

export function RuntimeVisualizer() {
  const [active, setActive] = useState(0);

  return (
    <div className="runtime-visualizer">
      <div className="runtime-track" role="tablist" aria-label="Run lifecycle">
        {stages.map((stage, index) => (
          <button
            type="button"
            role="tab"
            aria-selected={active === index}
            aria-controls="runtime-stage-detail"
            key={stage.label}
            onClick={() => setActive(index)}
          >
            <span className="runtime-dot">{index + 1}</span>
            <strong>{stage.label}</strong>
            <small>{stage.caption}</small>
          </button>
        ))}
      </div>
      <div className="runtime-detail" id="runtime-stage-detail" role="tabpanel">
        <span>0{active + 1} / 05</span>
        <p>{stages[active].detail}</p>
      </div>
    </div>
  );
}
