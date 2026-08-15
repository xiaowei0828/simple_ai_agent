import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_APP_CONFIG,
  loadAppConfig,
  resolveRuntimeModelConfig,
} from "../src/config/app-config.js";

describe("application configuration", () => {
  it("loads API, endpoint, and model settings from JSON", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-config-"));
    const configPath = path.join(root, "config.json");
    await writeFile(configPath, JSON.stringify({
      apiKey: "config-key",
      baseUrl: "https://example.test/v1",
      models: {
        default: "model-b",
        available: ["model-a", "model-b"],
      },
    }), "utf8");

    await expect(loadAppConfig(configPath)).resolves.toEqual({
      apiKey: "config-key",
      baseUrl: "https://example.test/v1",
      models: {
        default: "model-b",
        available: ["model-a", "model-b"],
      },
    });
  });

  it("uses defaults when the local configuration file is absent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-missing-config-"));
    await expect(loadAppConfig(path.join(root, "config.json"))).resolves.toEqual(DEFAULT_APP_CONFIG);
  });

  it("lets environment and CLI values override local configuration", () => {
    expect(resolveRuntimeModelConfig({
      apiKey: "config-key",
      baseUrl: "https://config.test/v1",
      models: { default: "config-model", available: ["config-model"] },
    }, {
      apiKey: " environment-key ",
      baseUrl: " https://environment.test/v1 ",
      model: " cli-model ",
    })).toEqual({
      apiKey: "environment-key",
      baseUrl: "https://environment.test/v1",
      model: "cli-model",
    });
  });

  it("rejects malformed configuration and an unavailable default model", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-invalid-config-"));
    const configPath = path.join(root, "config.json");
    await writeFile(configPath, JSON.stringify({
      apiKey: "key",
      baseUrl: "not-a-url",
      models: { default: "missing", available: ["available"] },
    }), "utf8");

    await expect(loadAppConfig(configPath)).rejects.toThrow("Invalid configuration file");
  });
});
