import { createProvider, type Model, type Provider } from "@earendil-works/pi-ai";
import {
  stream as openAICodexStream,
  streamSimple as openAICodexStreamSimple,
} from "@earendil-works/pi-ai/api/openai-codex-responses";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
// Pi's public provider factory deliberately lazy-loads OAuth with a relative
// dynamic import. Koni ships one standalone artifact, so bind the implementation
// from the exact pinned package and let esbuild include it in that artifact.
import { openaiCodexOAuth } from "../node_modules/@earendil-works/pi-ai/dist/utils/oauth/openai-codex.js";

export function koniOpenAICodexProvider(): Provider<"openai-codex-responses"> {
  return createProvider<"openai-codex-responses">({
    id: "openai-codex",
    name: "OpenAI Codex",
    baseUrl: "https://chatgpt.com/backend-api",
    auth: { oauth: openaiCodexOAuth },
    models: Object.values(OPENAI_CODEX_MODELS) as Model<"openai-codex-responses">[],
    api: { stream: openAICodexStream, streamSimple: openAICodexStreamSimple },
  });
}
