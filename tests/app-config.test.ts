import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  listConfiguredModels,
  loadAppConfig,
  resolveRuntimeModelConfig,
  type AppConfig,
} from "../src/config/app-config.js";

const config: AppConfig = [
  { apiKey: "first-key", baseUrl: "https://first.test/v1", models: ["model-b", "model-a"], reasoningSummary: "detailed" },
  { apiKey: "second-key", baseUrl: "https://second.test/v1", models: ["model-c"], reasoningSummary: "off" },
];

describe("application configuration", () => {
  it("loads multiple API connections with model arrays", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-config-"));
    const configPath = path.join(root, "config.json");
    await writeFile(configPath, JSON.stringify(config), "utf8");
    await expect(loadAppConfig(configPath)).resolves.toEqual(config);
  });

  it("reports the path when the required configuration file is absent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-missing-config-"));
    await expect(loadAppConfig(path.join(root, "config.json"))).rejects.toThrow("Unable to read configuration file");
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

  it("defaults to the first connection's first model and resolves other connections by model", () => {
    expect(resolveRuntimeModelConfig(config)).toEqual({
      connectionIndex: 0, selector: "model-b", model: "model-b",
      apiKey: "first-key", baseUrl: "https://first.test/v1", reasoningSummary: "detailed",
    });
    expect(resolveRuntimeModelConfig(config, "model-c")).toEqual({
      connectionIndex: 1, selector: "model-c", model: "model-c",
      apiKey: "second-key", baseUrl: "https://second.test/v1", reasoningSummary: undefined,
    });
    expect(resolveRuntimeModelConfig([{ ...config[0]!, reasoningSummary: undefined }]).reasoningSummary).toBe("auto");
  });

  it("distinguishes duplicate model names without silently selecting a connection", () => {
    const shared: AppConfig = [
      { ...config[0]!, models: ["shared"] },
      { ...config[1]!, models: ["shared", "unique"] },
    ];
    expect(listConfiguredModels(shared).map((choice) => choice.selector)).toEqual(["1:shared", "2:shared", "unique"]);
    expect(resolveRuntimeModelConfig(shared).selector).toBe("1:shared");
    expect(resolveRuntimeModelConfig(shared, "2:shared")).toMatchObject({
      connectionIndex: 1, model: "shared", apiKey: "second-key", baseUrl: "https://second.test/v1",
    });
    expect(() => resolveRuntimeModelConfig(shared, "shared")).toThrow("multiple connections");
    expect(() => resolveRuntimeModelConfig(shared, "missing")).toThrow("Unknown model");
  });

  it("rejects malformed configuration arrays and empty or duplicate model lists", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-invalid-config-"));
    const configPath = path.join(root, "config.json");
    for (const invalid of [
      {}, [], [{ ...config[0], apiKey: " " }], [{ ...config[0], baseUrl: "not-a-url" }],
      [{ ...config[0], models: [] }], [{ ...config[0], models: [" "] }],
      [{ ...config[0], models: { default: "a", available: ["a"] } }],
      [{ ...config[0], models: ["a", "a"] }], [{ ...config[0], models: ["a", "A"] }],
    ]) {
      await writeFile(configPath, JSON.stringify(invalid), "utf8");
      await expect(loadAppConfig(configPath)).rejects.toThrow("Invalid configuration file");
    }
  });

  it("reports the connection index for an invalid reasoning summary mode", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-invalid-reasoning-"));
    const configPath = path.join(root, "config.json");
    await writeFile(configPath, JSON.stringify([config[0], { ...config[1], reasoningSummary: "everything" }]), "utf8");
    await expect(loadAppConfig(configPath)).rejects.toThrow("1.reasoningSummary");
  });
});
