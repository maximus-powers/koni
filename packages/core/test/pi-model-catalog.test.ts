import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeRoleModelSubstitutions,
  loadSealedPiModelBinding,
  nearestSupportedThinkingLevel,
  projectSealedPiModelCatalog,
  resolveRoleModelSelections,
  sealPiModelDescriptor,
  sealedPiModelDescriptor,
  supportedThinkingLevels,
} from "../src/pi/model-catalog.js";
import type { ControlModelOption } from "../src/control-center/protocol.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("sealed Pi model catalog", () => {
  it("hash-binds the secret-free transport descriptor while excluding provider headers", () => {
    const base = fixtureModel();
    const first = sealPiModelDescriptor(base);
    const repeated = sealPiModelDescriptor(structuredClone(base));
    const differentSecret = sealPiModelDescriptor({
      ...base,
      headers: { Authorization: "Bearer another-secret" },
    });

    expect(repeated).toEqual(first);
    expect(differentSecret).toEqual(first);
    expect(first).toMatchObject({
      catalogContextWindow: base.contextWindow,
      catalogMaxTokens: base.maxTokens,
    });
    expect(sealedPiModelDescriptor(base)).not.toHaveProperty("headers");
    expect(JSON.stringify(sealedPiModelDescriptor(base))).not.toContain("disposable-secret");

    expect(
      sealPiModelDescriptor({ ...base, baseUrl: "https://different.invalid/v1" }).catalogSha256,
    ).not.toBe(first.catalogSha256);
    expect(
      sealPiModelDescriptor({ ...base, maxTokens: base.maxTokens + 1 }).catalogSha256,
    ).not.toBe(first.catalogSha256);
    expect(
      sealPiModelDescriptor({ ...base, compat: { supportsToolSearch: false } }).catalogSha256,
    ).not.toBe(first.catalogSha256);
  });

  it("loads only an exact model from Pi's offline executable snapshot", async () => {
    const model = fixtureModel();
    const runtime = { getAvailableSnapshot: () => [model] };
    await expect(loadSealedPiModelBinding(model.provider, model.id, { runtime })).resolves.toEqual(
      sealPiModelDescriptor(model),
    );
    await expect(loadSealedPiModelBinding(model.provider, "absent", { runtime })).rejects.toEqual(
      expect.objectContaining({ code: "model_unavailable" }),
    );
    await expect(
      loadSealedPiModelBinding(model.provider, model.id, {
        runtime: {
          getAvailableSnapshot: () => [model, { ...model, maxTokens: model.maxTokens - 1 }],
        },
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "model_unavailable",
        message: expect.stringContaining("ambiguous"),
      }),
    );
  });

  it("refuses to persist model endpoints with embedded credentials", () => {
    expect(() =>
      sealPiModelDescriptor({
        ...fixtureModel(),
        baseUrl: "https://user:secret@example.invalid/v1",
      }),
    ).toThrowError(expect.objectContaining({ code: "model_descriptor_invalid" }));
  });

  it("projects Pi 0.80.10 thinkingLevelMap semantics per model", () => {
    expect(
      supportedThinkingLevels({
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
      }),
    ).toEqual(["low", "high"]);
    expect(
      supportedThinkingLevels({
        provider: "openai-codex",
        id: "max-model",
        name: "Max Model",
        reasoning: true,
        thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
      }),
    ).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(
      supportedThinkingLevels({
        provider: "plain",
        id: "no-reasoning",
        name: "No Reasoning",
        reasoning: false,
        thinkingLevelMap: { max: "max" },
      }),
    ).toEqual(["off"]);
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
      streamSimple: extensionStream,
      models: [
        {
          id: "extension-only",
          name: "Extension Only",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 16_384,
          maxTokens: 2_048,
        },
      ],
    });
    await ambientRuntime.refresh({ allowNetwork: false });

    const ambientRegistry = new ModelRegistry(ambientRuntime);
    const standalone = projectSealedPiModelCatalog(sealedRuntime);
    const interactive = projectSealedPiModelCatalog(sealedRuntime, ambientRegistry);
    const adversary = interactive.find(
      (model) => model.provider === "ambient-adversary" && model.id === "extension-only",
    );

    expect(adversary).toEqual(
      expect.objectContaining({
        available: false,
        unavailableReason: expect.stringContaining("ambient Pi extension"),
      }),
    );
    expect(interactive.filter((model) => model.available)).toEqual(
      standalone.filter((model) => model.available),
    );
    expect(interactive.filter((model) => model.provider !== "ambient-adversary")).toEqual(
      standalone,
    );
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
    expect(standalone.find((model) => model.id === "locked")).toEqual(
      expect.objectContaining({
        available: false,
        unavailableReason: expect.stringContaining("current Pi credentials"),
      }),
    );
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
    if (address === null || typeof address === "string")
      throw new Error("test server has no TCP address");
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
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    expect(requests).toBe(0);
    expect(await readFile(authPath, "utf8")).toBe(authBytes);
    expect(await readFile(modelsPath, "utf8")).toBe(modelBytes);
  });
});

describe("authenticated role model resolution", () => {
  it("keeps declared defaults that this Pi installation can execute", () => {
    const resolved = resolveRoleModelSelections(
      [role("lead", "anthropic", "claude-opus", "high")],
      [option("anthropic", "claude-opus"), option("openai-codex", "gpt-sol")],
    );
    expect(resolved.substitutions).toEqual([]);
    expect(resolved.roles[0]).toMatchObject({ provider: "anthropic", model: "claude-opus" });
  });

  it("prefers another model from the same provider before crossing providers", () => {
    const resolved = resolveRoleModelSelections(
      [role("lead", "anthropic", "claude-retired", "high")],
      [option("openai-codex", "gpt-sol"), option("anthropic", "claude-sonnet")],
    );
    expect(resolved.roles[0]).toMatchObject({ provider: "anthropic", model: "claude-sonnet" });
    expect(resolved.substitutions[0]).toMatchObject({
      roleId: "lead",
      from: { provider: "anthropic", model: "claude-retired" },
      to: { provider: "anthropic", model: "claude-sonnet" },
    });
  });

  it("crosses providers when the configured provider is not authenticated at all", () => {
    const resolved = resolveRoleModelSelections(
      [role("lead", "openai-codex", "gpt-sol", "high")],
      [option("anthropic", "claude-opus")],
    );
    expect(resolved.roles[0]).toMatchObject({ provider: "anthropic", model: "claude-opus" });
    expect(describeRoleModelSubstitutions(resolved.substitutions)).toContain(
      "openai-codex/gpt-sol → anthropic/claude-opus",
    );
  });

  it("lowers reasoning only to a level the substituted model supports", () => {
    const resolved = resolveRoleModelSelections(
      [role("lead", "openai-codex", "gpt-sol", "max")],
      [{ ...option("anthropic", "claude-opus"), thinkingLevels: ["off", "low", "medium"] }],
    );
    expect(resolved.roles[0]?.thinkingLevel).toBe("medium");
  });

  it("leaves an unsupported reasoning level on an executable model for admission to reject", () => {
    const resolved = resolveRoleModelSelections(
      [role("lead", "anthropic", "claude-opus", "max")],
      [{ ...option("anthropic", "claude-opus"), thinkingLevels: ["off", "low"] }],
    );
    expect(resolved.substitutions).toEqual([]);
    expect(resolved.roles[0]).toMatchObject({ model: "claude-opus", thinkingLevel: "max" });
  });

  it("returns the declared defaults unchanged when nothing is executable", () => {
    const resolved = resolveRoleModelSelections(
      [role("lead", "openai-codex", "gpt-sol", "high")],
      [{ ...option("anthropic", "claude-opus"), available: false }],
    );
    expect(resolved.substitutions).toEqual([]);
    expect(resolved.roles[0]).toMatchObject({ provider: "openai-codex", model: "gpt-sol" });
    expect(describeRoleModelSubstitutions(resolved.substitutions)).toBeUndefined();
  });

  it("resolves an unsupported reasoning level upward before downward", () => {
    expect(nearestSupportedThinkingLevel(["off", "medium", "xhigh"], "high")).toBe("xhigh");
    expect(nearestSupportedThinkingLevel(["off", "low"], "max")).toBe("low");
    expect(nearestSupportedThinkingLevel([], "high")).toBe("high");
  });
});

function role(id: string, provider: string, model: string, thinkingLevel: "high" | "max") {
  return {
    id,
    title: id.replace(/^./u, (first) => first.toLocaleUpperCase("en-US")),
    provider,
    model,
    thinkingLevel,
  } as const;
}

function option(provider: string, id: string): ControlModelOption {
  return {
    provider,
    id,
    name: id,
    reasoning: true,
    thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
    available: true,
  };
}

function fixtureModel(): Model<Api> {
  return {
    provider: "openai-codex",
    id: "gpt-fixture",
    name: "Fixture",
    api: "openai-codex-responses",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 372_000,
    maxTokens: 128_000,
    headers: { Authorization: "Bearer disposable-secret" },
    compat: { supportsToolSearch: true },
  };
}
