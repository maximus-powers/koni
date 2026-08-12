import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { createKoniAuthorityTools, KONI_TOOL_RECEIPT_PROTOCOL } from "../src/pi/tool-catalog.js";

describe("terminal submit transport schema", () => {
  it("names mutually exclusive branch fields the flattened object would otherwise allow", () => {
    // The union is merged for transport (root unions flatten to zero properties in provider tool
    // transforms), which turns branch-exclusive fields into optional siblings. An agent reading
    // that shape sees `graphDelta` and `upstreamChangeRequest` as combinable; the authority
    // refuses the pair and discards the attempt. The description must carry what the shape lost.
    const schema = Type.Union([
      Type.Object(
        { status: Type.Literal("completed"), summary: Type.String(), graphDelta: Type.Object({}) },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          status: Type.Literal("completed"),
          summary: Type.String(),
          upstreamChangeRequest: Type.Object({}),
        },
        { additionalProperties: false },
      ),
      Type.Object(
        { status: Type.Literal("failed"), blocker: Type.String() },
        { additionalProperties: false },
      ),
    ]);
    const tools = createKoniAuthorityTools({
      names: ["koni_submit_output"],
      terminalOutputSchema: schema,
      async invoke() {
        return {
          protocol: KONI_TOOL_RECEIPT_PROTOCOL,
          receiptId: "r",
          outcome: "accepted" as const,
          summary: "s",
        };
      },
      async reject() {
        return {
          protocol: KONI_TOOL_RECEIPT_PROTOCOL,
          receiptId: "r",
          outcome: "rejected" as const,
          code: "c",
          summary: "s",
        };
      },
    });
    const submit = tools.find((tool) => tool.name === "koni_submit_output")!;
    const described = JSON.stringify(submit);
    expect(described).toContain("must never be combined");
    expect(described).toContain("graphDelta");
    expect(described).toContain("upstreamChangeRequest");
    expect(described).toContain("discards the attempt");
  });
});
