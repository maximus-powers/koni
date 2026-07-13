"use client";

import { useState } from "react";

const layers = [
  {
    id: "catalog",
    path: ".codex/koni/project.yaml",
    label: "Catalog",
    detail: "Names the project profile and complete, selectable run types.",
    color: "violet",
  },
  {
    id: "profile",
    path: ".codex/koni/profile.yaml",
    label: "Semantic profile",
    detail: "Imports the graph, rules, workflows, actions, checks, and reports.",
    color: "cyan",
  },
  {
    id: "agents",
    path: ".codex/agents/*.toml",
    label: "Native agents",
    detail: "Binds each role to instructions, model, reasoning, tools, and permissions.",
    color: "lime",
  },
  {
    id: "skills",
    path: ".agents/skills/*",
    label: "Agent knowledge",
    detail: "Teaches Codex how to configure and operate this project’s Köni model.",
    color: "gold",
  },
] as const;

export function ConfigStack() {
  const [active, setActive] = useState(0);
  const layer = layers[active];

  return (
    <div className="config-stack">
      <div className="config-layers" role="tablist" aria-label="Köni configuration layers">
        {layers.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active === index}
            aria-controls="config-layer-detail"
            onClick={() => setActive(index)}
            className={`config-layer layer-${item.color}`}
          >
            <span>{String(index + 1).padStart(2, "0")}</span>
            <div><strong>{item.label}</strong><code>{item.path}</code></div>
            <i aria-hidden="true">↗</i>
          </button>
        ))}
      </div>
      <div className={`config-detail detail-${layer.color}`} id="config-layer-detail" role="tabpanel">
        <span>Selected layer</span>
        <strong>{layer.label}</strong>
        <p>{layer.detail}</p>
        <code>{layer.path}</code>
      </div>
    </div>
  );
}
