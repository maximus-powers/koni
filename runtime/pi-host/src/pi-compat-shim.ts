import { EventStream, validateToolArguments } from "@earendil-works/pi-ai";

export { EventStream, validateToolArguments };

/**
 * Pi Agent retains a compatibility default even when the caller injects a
 * stream function. Koni always injects its direct, credential-brokered model
 * stream, so reaching this fallback is a packaging or runtime defect.
 */
export function streamSimple(): never {
  throw new Error("Koni Pi host disabled the ambient compatibility stream");
}
