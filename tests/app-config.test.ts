import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { REASONING_EFFORTS } from "../src/core/types.js";
import {
  listConfiguredModels,
  loadAppConfig,
  resolveRuntimeModelConfig,
  type AppConfig,
} from "../src/config/app-config.js";

const config: AppConfig = {
  connections: [
    { apiKey: "first-key", baseUrl: "https://first.test/v1", models: [{ id: "model-b", reasoningSummary: "detailed" }, { id: "model-a" }] },
    { apiKey: "second-key", baseUrl: "https://second.test/v1", models: [{ id: "model-c", reasoningSummary: "off" }] },
  ],
};

async function configFile(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-config-"));
  return path.join(root, "config.json");
}

describe("application configuration", () => {
  it("loads an optional defaults block alongside multiple API connections", async () => {
    const configPath = await configFile();
    for (const defaults of [undefined, {}, { reasoningEffort: "medium", reasoningSummary: "auto" }]) {
      const input = { ...config, ...(defaults ? { defaults } : {}) };
      await writeFile(configPath, JSON.stringify(input), "utf8");
      await expect(loadAppConfig(configPath)).resolves.toEqual(input);
    }
  });

  it("reports the path when the required configuration file is absent", async () => {
    await expect(loadAppConfig(await configFile())).rejects.toThrow("Unable to read configuration file");
  });

  it("uses configuration values even when SDK environment variables are set", () => {
    vi.stubEnv("OPENAI_API_KEY", "environment-fixture-key");
    vi.stubEnv("OPENAI_BASE_URL", "https://environment.test/v1");
    try {
      expect(resolveRuntimeModelConfig(config, "model-c")).toMatchObject({
        apiKey: "second-key", baseUrl: "https://second.test/v1", model: "model-c",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("uses code defaults and selects models across connections", () => {
    expect(resolveRuntimeModelConfig(config)).toEqual({
      connectionIndex: 0, selector: "model-b", model: "model-b",
      apiKey: "first-key", baseUrl: "https://first.test/v1", reasoningSummary: "detailed",
      reasoningEffort: "medium", supportedReasoningEfforts: REASONING_EFFORTS,
    });
    expect(resolveRuntimeModelConfig(config, "model-c")).toEqual({
      connectionIndex: 1, selector: "model-c", model: "model-c",
      apiKey: "second-key", baseUrl: "https://second.test/v1", reasoningSummary: undefined,
      reasoningEffort: "medium", supportedReasoningEfforts: REASONING_EFFORTS,
    });
    expect(resolveRuntimeModelConfig(config, "model-a").reasoningSummary).toBe("auto");
  });

  it("resolves shared defaults before validating per-model overrides and supported efforts", async () => {
    const configPath = await configFile();
    const input: AppConfig = {
      defaults: { reasoningEffort: "high", reasoningSummary: "concise" },
      connections: [{ ...config.connections[0]!, models: [
        { id: "inherited", contextWindow: 300_000, supportedReasoningEfforts: ["high", "max"] },
        { id: "overridden", contextWindow: 32_000, reasoningEffort: "none", reasoningSummary: "off", supportedReasoningEfforts: ["none"] },
        { id: "partial", reasoningSummary: "detailed" },
      ] }],
    };
    await writeFile(configPath, JSON.stringify(input));
    const loaded = await loadAppConfig(configPath);
    expect(resolveRuntimeModelConfig(loaded, "inherited")).toMatchObject({
      contextWindow: 300_000, reasoningEffort: "high", reasoningSummary: "concise", supportedReasoningEfforts: ["high", "max"],
    });
    expect(resolveRuntimeModelConfig(loaded, "overridden")).toMatchObject({
      contextWindow: 32_000, reasoningEffort: "none", reasoningSummary: undefined, supportedReasoningEfforts: ["none"],
    });
    expect(resolveRuntimeModelConfig(loaded, "partial")).toMatchObject({ reasoningEffort: "high", reasoningSummary: "detailed" });
    expect(resolveRuntimeModelConfig(config).contextWindow).toBeUndefined();
  });

  it("preserves an explicit summary-off default and allows models to enable summaries", () => {
    const shared: AppConfig = { ...config, defaults: { reasoningSummary: "off" } };
    expect(resolveRuntimeModelConfig(shared, "model-a")).toMatchObject({ reasoningSummary: undefined, reasoningEffort: "medium" });
    expect(resolveRuntimeModelConfig(shared, "model-b").reasoningSummary).toBe("detailed");
    expect(resolveRuntimeModelConfig({ ...config, defaults: { reasoningEffort: "high" } }, "model-a"))
      .toMatchObject({ reasoningEffort: "high", reasoningSummary: "auto" });
  });

  it("distinguishes duplicate model names without silently selecting a connection", () => {
    const shared: AppConfig = { connections: [
      { ...config.connections[0]!, models: [{ id: "shared" }] },
      { ...config.connections[1]!, models: [{ id: "shared" }, { id: "unique" }] },
    ] };
    expect(listConfiguredModels(shared).map((choice) => choice.selector)).toEqual(["1:shared", "2:shared", "unique"]);
    expect(resolveRuntimeModelConfig(shared).selector).toBe("1:shared");
    expect(resolveRuntimeModelConfig(shared, "2:shared")).toMatchObject({
      connectionIndex: 1, model: "shared", apiKey: "second-key", baseUrl: "https://second.test/v1",
    });
    expect(() => resolveRuntimeModelConfig(shared, "shared")).toThrow("multiple connections");
    expect(() => resolveRuntimeModelConfig(shared, "missing")).toThrow("Unknown model");
  });

  it("rejects the old root array and malformed connection/model lists", async () => {
    const configPath = await configFile();
    for (const invalid of [
      {}, [], config.connections, { connections: [] },
      ...[
        { models: ["old-string-format"] }, { apiKey: " " }, { baseUrl: "not-a-url" },
        { models: [] }, { models: [{ id: " " }] }, { models: { default: "a", available: ["a"] } },
        { models: [{ id: "a" }, { id: "a" }] }, { models: [{ id: "a" }, { id: "A" }] },
      ].map((override) => ({ connections: [{ ...config.connections[0], ...override }] })),
    ]) {
      await writeFile(configPath, JSON.stringify(invalid));
      await expect(loadAppConfig(configPath)).rejects.toThrow("Invalid configuration file");
    }
  });

  it("reports the full model path for invalid reasoning and context settings", async () => {
    const configPath = await configFile();
    for (const invalid of [
      { reasoningSummary: "everything" }, { reasoningEffort: "off" },
      ...[-1, 0, 1_023, 300_000.5, "300000"].map((contextWindow) => ({ contextWindow })),
      { supportedReasoningEfforts: [] }, { supportedReasoningEfforts: ["unknown"] },
      { supportedReasoningEfforts: ["medium", "medium"] },
      { supportedReasoningEfforts: ["low", "high"] },
      { reasoningEffort: "high", supportedReasoningEfforts: ["medium"] },
    ]) {
      await writeFile(configPath, JSON.stringify({ connections: [config.connections[0], {
        ...config.connections[1], models: [{ id: "model-c", ...invalid }],
      }] }));
      await expect(loadAppConfig(configPath)).rejects.toThrow("connections.1.models.0.");
    }
  });

  it("rejects inherited efforts outside a model's supported list", async () => {
    const configPath = await configFile();
    await writeFile(configPath, JSON.stringify({ defaults: { reasoningEffort: "max" }, connections: [{
      ...config.connections[0], models: [{ id: "limited", supportedReasoningEfforts: ["medium", "high"] }],
    }] }));
    await expect(loadAppConfig(configPath)).rejects.toThrow("connections.0.models.0.reasoningEffort: effective reasoning effort 'max'");
  });

  it("accepts only reasoning defaults in the shared block", async () => {
    const configPath = await configFile();
    for (const defaults of [
      { reasoningEffort: "invalid" }, { reasoningSummary: "invalid" },
      { contextWindow: 300_000 }, { supportedReasoningEfforts: ["medium"] },
    ]) {
      await writeFile(configPath, JSON.stringify({ ...config, defaults }));
      await expect(loadAppConfig(configPath)).rejects.toThrow("defaults");
    }
    for (const obsolete of [
      { compaction: { contextWindow: 300_000 } }, { contextWindow: 300_000 },
      { reasoningEffort: "medium" }, { reasoningSummary: "auto" },
    ]) {
      await writeFile(configPath, JSON.stringify({ connections: [{ ...config.connections[0], ...obsolete }] }));
      await expect(loadAppConfig(configPath)).rejects.toThrow("Unrecognized key");
    }
  });
});
