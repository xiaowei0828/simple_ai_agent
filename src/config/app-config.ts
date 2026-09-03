import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ReasoningSummaryMode } from "../core/types.js";

export const DEFAULT_REASONING_SUMMARY = "auto" as const;

const connectionConfigSchema = z.object({
  apiKey: z.string().trim().min(1),
  baseUrl: z.string().url(),
  models: z.array(z.string().trim().min(1)).min(1),
  reasoningSummary: z.enum(["off", "auto", "concise", "detailed"]).optional(),
}).strict().superRefine((config, context) => {
  if (new Set(config.models.map((model) => model.toLowerCase())).size !== config.models.length) {
    context.addIssue({
      code: "custom",
      path: ["models"],
      message: "model names must be unique within each connection",
    });
  }
});

const appConfigSchema = z.array(connectionConfigSchema).min(1).superRefine((config, context) => {
  const choices = listConfiguredModels(config).map((choice) => choice.selector.toLowerCase());
  if (new Set(choices).size !== choices.length) {
    context.addIssue({ code: "custom", message: "model names conflict with generated connection selectors" });
  }
});

export type AppConfig = z.infer<typeof appConfigSchema>;

export interface ConfiguredModelChoice {
  connectionIndex: number;
  model: string;
  selector: string;
}

export interface RuntimeModelConfig extends ConfiguredModelChoice {
  apiKey: string;
  baseUrl: string;
  reasoningSummary?: ReasoningSummaryMode;
}

export function resolveAppConfigPath(cwd: string = process.cwd()): string {
  return path.resolve(cwd, ".config", "config.json");
}

export async function loadAppConfig(configPath: string): Promise<AppConfig> {
  let contents: string;
  try {
    contents = await readFile(configPath, "utf8");
  } catch (error) {
    throw new Error(`Unable to read configuration file '${configPath}': ${errorMessage(error)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Invalid JSON in configuration file '${configPath}': ${errorMessage(error)}`);
  }

  const result = appConfigSchema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid configuration file '${configPath}': ${details}`);
  }
  return result.data;
}

export function resolveRuntimeModelConfig(
  config: AppConfig,
  model?: string,
): RuntimeModelConfig {
  const choices = listConfiguredModels(config);
  const selector = model?.trim() || undefined;
  const choice = selector === undefined ? choices[0] : choices.find((entry) => entry.selector === selector);
  if (!choice) {
    const matches = choices.filter((entry) => entry.model === selector);
    if (matches.length > 1) {
      throw new Error(`Model '${selector}' is available in multiple connections. Choose ${matches.map((entry) => entry.selector).join(" or ")}.`);
    }
    throw new Error(selector ? `Unknown model: ${selector}. Choose a configured model.` : "No models are configured.");
  }
  const connection = config[choice.connectionIndex]!;
  return {
    ...choice,
    apiKey: connection.apiKey.trim(),
    baseUrl: connection.baseUrl,
    reasoningSummary: connection.reasoningSummary === "off"
      ? undefined : connection.reasoningSummary ?? DEFAULT_REASONING_SUMMARY,
  };
}

export function listConfiguredModels(config: ReadonlyArray<z.infer<typeof connectionConfigSchema>>): ConfiguredModelChoice[] {
  const counts = new Map<string, number>();
  for (const connection of config) {
    for (const model of connection.models) {
      const key = model.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return config.flatMap((connection, connectionIndex) => connection.models.map((model) => ({
    connectionIndex,
    model,
    selector: counts.get(model.toLowerCase())! > 1 ? `${connectionIndex + 1}:${model}` : model,
  })));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
