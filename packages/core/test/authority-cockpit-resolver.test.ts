import { describe, expect, it, vi } from "vitest";
import type { JsonValue, RpcSuccess } from "../src/authority/protocol.js";
import {
  COCKPIT_CATALOG_AUTHORITY_METHOD,
  createAuthorityCockpitCatalogResolver,
} from "../src/control-center/authority-cockpit-resolver.js";
import { rawSha256 } from "../src/shared/canonical.js";

describe("authority-backed cockpit catalog resolver", () => {
  it("requests only the selected run and exact pinned configuration digest", async () => {
    const configurationSha256 = rawSha256("pinned-configuration");
    const catalog = {
      protocol: "koni.compiled-cockpit-catalog.v1",
      configurationSha256,
      views: [],
      catalogSha256: rawSha256("catalog"),
    } satisfies JsonValue;
    const request = vi.fn(async (): Promise<RpcSuccess> => ({
      type: "response",
      id: "response-1",
      ok: true,
      revision: 7,
      result: catalog,
    }));

    const resolver = createAuthorityCockpitCatalogResolver({ request });
    await expect(resolver.resolve({ runId: "run-1", configurationSha256 })).resolves.toEqual(
      catalog,
    );
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(COCKPIT_CATALOG_AUTHORITY_METHOD, {
      runId: "run-1",
      configurationSha256,
    });
  });
});
