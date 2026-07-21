import type { JsonValue, RpcSuccess } from "../authority/protocol.js";
import type {
  CockpitCatalogResolutionRequest,
  ControlCenterCockpitCatalogResolver,
} from "./cockpit-config.js";

/**
 * The deliberately tiny read-only authority surface required by the cockpit resolver.
 *
 * Reusing the control center's already-authenticated client keeps both `/koni` and `koni tui`
 * on the same project authority connection. The server, not this presentation adapter, resolves
 * the immutable run snapshot and verifies its configuration digest.
 */
export interface CockpitAuthorityClient {
  request(method: string, params?: JsonValue): Promise<RpcSuccess>;
}

export const COCKPIT_CATALOG_AUTHORITY_METHOD = "control.cockpit" as const;

export function createAuthorityCockpitCatalogResolver(
  client: CockpitAuthorityClient,
): ControlCenterCockpitCatalogResolver {
  return Object.freeze({
    async resolve(request: CockpitCatalogResolutionRequest): Promise<unknown> {
      const response = await client.request(COCKPIT_CATALOG_AUTHORITY_METHOD, {
        runId: request.runId,
        configurationSha256: request.configurationSha256,
      });
      return response.result;
    },
  });
}
