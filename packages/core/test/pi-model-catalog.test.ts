import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  projectSealedPiModelCatalog,
  supportedThinkingLevels,
} from "../src/pi/model-catalog.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("sealed Pi model catalog", () => {
  it("projects Pi 0.80.10 thinkingLevelMap semantics per model", () => {
    expect(supportedThinkingLevels({
      provider: "google",
      id: "flash-lite",
      name: "Flash Lite",
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: "LOW",
        medium: null,
        high: "HIGH",
      },
    })).toEqual(["low", "high"]);
    expect(supportedThinkingLevels({
      provider: "openai-codex",
      id: "max-model",
      name: "Max Model",
      reasoning: true,
      thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
    })).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(supportedThinkingLevels({
      provider: "plain",
      id: "no-reasoning",
      name: "No Reasoning",
      reasoning: false,
      thinkingLevelMap: { max: "max" },
    })).toEqual(["off"]);
  });

  it("keeps an adversarial registerProvider model visible but unavailable and out of the child runtime", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "koni-model-catalog-"));
    temporaryRoots.push(root);
    const runtimeOptions = {
      authPath: path.join(root, "auth.json"),
      modelsPath: path.join(root, "models.json"),
      modelsStorePath: path.join(root, "models-store.json"),
      allowModelNetwork: false,
    } as const;
    const [ambientRuntime, sealedRuntime] = await Promise.all([
      ModelRuntime.create(runtimeOptions),
      ModelRuntime.create(runtimeOptions),
    ]);
    const extensionStream = vi.fn(() => {
      throw new Error("ambient provider function must never execute");
    });
    ambientRuntime.registerProvider("ambient-adversary", {
      name: "Ambient Adversary",
      baseUrl: "https://ambient.invalid/v1",
      apiKey: "disposable-test-key",
      api: "openai-completions",
      streamSimple: extensionStream as never,
      models: [{
        id: "extension-only",
        name: "Extension Only",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 16_384,
        maxTokens: 2_048,
      }],
    });
    await ambientRuntime.refresh({ allowNetwork: false });

    const ambientRegistry = new ModelRegistry(ambientRuntime);
    const standalone = projectSealedPiModelCatalog(sealedRuntime);
    const interactive = projectSealedPiModelCatalog(sealedRuntime, ambientRegistry);
    const adversary = interactive.find((model) =>
      model.provider === "ambient-adversary" && model.id === "extension-only");

    expect(adversary).toEqual(expect.objectContaining({
      available: false,
      unavailableReason: expect.stringContaining("ambient Pi extension"),
    }));
    expect(interactive.filter((model) => model.available)).toEqual(
      standalone.filter((model) => model.available),
    );
    expect(interactive.filter((model) => model.provider !== "ambient-adversary")).toEqual(standalone);
    expect(sealedRuntime.getRegisteredProviderIds()).toEqual([]);
    expect(sealedRuntime.getModel("ambient-adversary", "extension-only")).toBeUndefined();
    expect(extensionStream).not.toHaveBeenCalled();
  });

  it("uses the same unavailable semantics on both surfaces", () => {
    const native = { provider: "native", id: "ready", name: "Ready", reasoning: true };
    const noCredential = { provider: "native", id: "locked", name: "Locked", reasoning: true };
    const runtime = {
      getModels: () => [native, noCredential],
      getAvailableSnapshot: () => [native],
    };
    const standalone = projectSealedPiModelCatalog(runtime);
    const interactive = projectSealedPiModelCatalog(runtime, {
      getAll: () => [native, noCredential],
      getRegisteredProviderIds: () => [],
    });

    expect(interactive).toEqual(standalone);
    expect(standalone.find((model) => model.id === "locked")).toEqual(expect.objectContaining({
      available: false,
      unavailableReason: expect.stringContaining("current Pi credentials"),
    }));
  });

  it("finishes an offline availability refresh without network or auth/models rewrites", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "koni-model-offline-"));
    temporaryRoots.push(root);
    const authPath = path.join(root, "auth.json");
    const modelsPath = path.join(root, "models.json");
    const authBytes = "{}\n";
    const modelBytes = "{}\n";
    await writeFile(authPath, authBytes, { mode: 0o600 });
    await writeFile(modelsPath, modelBytes, { mode: 0o600 });
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(500).end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("test server has no TCP address");
    try {
      const runtime = await ModelRuntime.create({
        authPath,
        modelsPath,
        modelsStorePath: path.join(root, "models-store.json"),
        allowModelNetwork: false,
        catalogBaseUrl: `http://127.0.0.1:${address.port}`,
      });
      expect(runtime.getAvailableSnapshot()).toEqual(expect.any(Array));
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    expect(requests).toBe(0);
    expect(await readFile(authPath, "utf8")).toBe(authBytes);
    expect(await readFile(modelsPath, "utf8")).toBe(modelBytes);
  });
});
