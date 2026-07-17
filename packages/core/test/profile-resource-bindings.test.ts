import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parsePiResourceBindingCatalog,
  PiResourceBindingError,
  resolveOptionalPiResources,
} from "../src/profile/resource-bindings.js";

const codingCatalog = path.resolve(
  import.meta.dirname,
  "../../coding-profile/koni/baseline/resources/pi-packages.yaml",
);
const researchCatalog = path.resolve(
  import.meta.dirname,
  "../../research-profile/koni/baseline/resources/pi-packages.yaml",
);

describe("optional Pi package resource bindings", () => {
  it.each([
    ["coding", codingCatalog],
    ["research", researchCatalog],
  ])("parses the %s profile catalog with every community package opt-in", async (_name, catalogPath) => {
    const catalog = parsePiResourceBindingCatalog(await readFile(catalogPath, "utf8"));
    expect(catalog.protocol).toBe("koni.pi-resource-bindings.v1");
    expect(catalog.bindings.length).toBeGreaterThan(0);
    expect(catalog.bindings.every(({ enabled }) => enabled === false)).toBe(true);
    expect(catalog.bindings.find(({ id }) => id === "pi-subagents")?.integration).toBe("not_recommended");
  });

  it("only resolves explicitly enabled resources already present in Pi's inventory", () => {
    const catalog = parsePiResourceBindingCatalog(`
protocol: koni.pi-resource-bindings.v1
bindings:
  - id: installed
    package: useful-skills
    description: Explicit installed skill.
    enabled: true
    integration: skills_only
    resources: [skill]
    select:
      skills: [skills/useful/SKILL.md]
      prompts: []
      tools: []
    stages: [planning]
    personas: [planner]
    requires_network: false
    rationale: Selected by the project.
  - id: missing
    package: missing-tools
    description: Explicit missing tool.
    enabled: true
    integration: explicit_tools
    resources: [extension]
    select:
      skills: []
      prompts: []
      tools: [missing-network]
    stages: [verification]
    personas: [reviewer]
    requires_network: true
    rationale: Requires an explicit network grant.
  - id: ambient-disabled
    package: ambient-package
    description: Installed but disabled package.
    enabled: false
    integration: interactive_only
    resources: [extension]
    stages: []
    personas: []
    requires_network: false
    rationale: Remains ambient and outside contained attempts.
`);
    const resolved = resolveOptionalPiResources(catalog, [
      {
        packageName: "useful-skills",
        packageVersion: "1.0.0",
        packageRoot: "/tmp/pi/useful-skills",
        source: "npm:useful-skills",
        resources: [{ kind: "skill", relativePath: "skills/useful/SKILL.md", ambientEnabled: true }],
      },
      {
        packageName: "ambient-package",
        packageVersion: "1.0.0",
        packageRoot: "/tmp/pi/ambient-package",
        source: "npm:ambient-package",
        resources: [],
      },
      {
        packageName: "unrelated",
        packageVersion: "1.0.0",
        packageRoot: "/tmp/pi/unrelated",
        source: "npm:unrelated",
        resources: [],
      },
    ]);
    expect(resolved.enabled.map(({ id }) => id)).toEqual(["installed"]);
    expect(resolved.unavailable.map(({ id }) => id)).toEqual(["missing"]);
    expect(resolved.disabled.map(({ id }) => id)).toEqual(["ambient-disabled"]);
    expect(resolved.enabled[0]?.installedSource).toBe("npm:useful-skills");
  });

  it("rejects unknown fields and forbids enabling not-recommended schedulers", () => {
    const invalid = `
protocol: koni.pi-resource-bindings.v1
bindings:
  - id: pi-subagents
    package: pi-subagents
    description: A second scheduler.
    enabled: true
    integration: not_recommended
    resources: [extension]
    stages: []
    personas: []
    requires_network: false
    rationale: Must remain disabled.
    install_automatically: true
`;
    expect(() => parsePiResourceBindingCatalog(invalid)).toThrowError(
      expect.objectContaining({ code: "binding_unknown_field" }) as PiResourceBindingError,
    );
    expect(() => parsePiResourceBindingCatalog(invalid.replace("    install_automatically: true\n", ""))).toThrowError(
      expect.objectContaining({ code: "binding_unsafe_enable" }) as PiResourceBindingError,
    );
  });

  it("requires exact autonomous selectors and keeps interactive resources out of attempt scope", () => {
    const enabledWithoutSelection = `
protocol: koni.pi-resource-bindings.v1
bindings:
  - id: methods
    package: methods
    description: Selected methods.
    enabled: true
    integration: skills_only
    resources: [skill]
    stages: [planning]
    personas: [planner]
    requires_network: false
    rationale: Explicit selection is required.
`;
    expect(() => parsePiResourceBindingCatalog(enabledWithoutSelection)).toThrowError(
      expect.objectContaining({ code: "binding_selection" }) as PiResourceBindingError,
    );
    expect(() => parsePiResourceBindingCatalog(enabledWithoutSelection.replace(
      "    stages: [planning]",
      "    select: { skills: ['skills/**/SKILL.md'], prompts: [], tools: [] }\n    stages: [planning]",
    ))).toThrowError(expect.objectContaining({ code: "binding_resource_path" }) as PiResourceBindingError);
    expect(() => parsePiResourceBindingCatalog(enabledWithoutSelection
      .replace("    integration: skills_only", "    integration: interactive_only")
      .replace("    stages: [planning]", "    select: { skills: [skills/method/SKILL.md], prompts: [], tools: [] }\n    stages: []")
      .replace("    personas: [planner]", "    personas: []"))).toThrowError(
      expect.objectContaining({ code: "binding_interactive_scope" }) as PiResourceBindingError,
    );
  });
});
