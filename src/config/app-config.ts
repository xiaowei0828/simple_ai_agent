import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { REASONING_EFFORTS, type ReasoningEffort } from "../core/types.js";

const DEFAULT_REASONING_EFFORT = "medium" as const;

const effortSchema = z.enum(REASONING_EFFORTS);
const defaultsSchema = z.object({
  model: z.string().trim().min(1).optional(),
  reasoningEffort: effortSchema.optional(),
}).strict();

const modelConfigSchema = z.object({
  id: z.string().trim().min(1),
  reasoningEffort: effortSchema.optional(),
  contextWindow: z.number().int().min(1_024).optional(),
  supportedReasoningEfforts: z.array(effortSchema).min(1).optional(),
}).strict().superRefine((model, context) => {
  const supported = model.supportedReasoningEfforts ?? REASONING_EFFORTS;
  if (new Set(supported).size !== supported.length) {
    context.addIssue({ code: "custom", path: ["supportedReasoningEfforts"], message: "reasoning efforts must be unique" });
  }
});

const connectionConfigSchema = z.object({
  apiKey: z.string().trim().min(1),
  baseUrl: z.string().url(),
  models: z.array(modelConfigSchema).min(1),
}).strict().superRefine((config, context) => {
  if (new Set(config.models.map((model) => model.id.toLowerCase())).size !== config.models.length) {
    context.addIssue({
      code: "custom",
      path: ["models"],
      message: "model names must be unique within each connection",
    });
  }
});

const appConfigSchema = z.object({
  defaults: defaultsSchema.optional(),
  connections: z.array(connectionConfigSchema).min(1),
}).strict().superRefine((config, context) => {
  const selectors = listConfiguredModels(config).map((choice) => choice.selector);
  if (new Set(selectors.map((selector) => selector.toLowerCase())).size !== selectors.length) {
    context.addIssue({ code: "custom", message: "model names conflict with generated connection selectors" });
  }
  if (config.defaults?.model && !selectors.includes(config.defaults.model)) {
    context.addIssue({
      code: "custom",
      path: ["defaults", "model"],
      message: `unknown default model '${config.defaults.model}'`,
    });
  }
  for (const [connectionIndex, connection] of config.connections.entries()) {
    for (const [modelIndex, model] of connection.models.entries()) {
      const effort = model.reasoningEffort ?? config.defaults?.reasoningEffort ?? DEFAULT_REASONING_EFFORT;
      const supported = model.supportedReasoningEfforts ?? REASONING_EFFORTS;
      if (!supported.includes(effort)) {
        context.addIssue({
          code: "custom", path: ["connections", connectionIndex, "models", modelIndex, "reasoningEffort"],
          message: `effective reasoning effort '${effort}' must be in supportedReasoningEfforts`,
        });
      }
    }
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
  reasoningEffort: ReasoningEffort;
  supportedReasoningEfforts: readonly ReasoningEffort[];
  contextWindow?: number;
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
  const selector = model?.trim() || config.defaults?.model?.trim() || undefined;
  const choice = selector === undefined ? choices[0] : choices.find((entry) => entry.selector === selector);
  if (!choice) {
    const matches = choices.filter((entry) => entry.model === selector);
    if (matches.length > 1) {
      throw new Error(`Model '${selector}' is available in multiple connections. Choose ${matches.map((entry) => entry.selector).join(" or ")}.`);
    }
    throw new Error(selector ? `Unknown model: ${selector}. Choose a configured model.` : "No models are configured.");
  }
  const connection = config.connections[choice.connectionIndex]!;
  const selected = connection.models.find((entry) => entry.id === choice.model)!;
  return {
    ...choice,
    apiKey: connection.apiKey.trim(),
    baseUrl: connection.baseUrl,
    reasoningEffort: selected.reasoningEffort ?? config.defaults?.reasoningEffort ?? DEFAULT_REASONING_EFFORT,
    supportedReasoningEfforts: selected.supportedReasoningEfforts ?? REASONING_EFFORTS,
    ...(selected.contextWindow !== undefined ? { contextWindow: selected.contextWindow } : {}),
  };
}

export function listConfiguredModels(config: { connections: ReadonlyArray<z.infer<typeof connectionConfigSchema>> }): ConfiguredModelChoice[] {
  const counts = new Map<string, number>();
  for (const connection of config.connections) {
    for (const model of connection.models) {
      const key = model.id.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return config.connections.flatMap((connection, connectionIndex) => connection.models.map((model) => ({
    connectionIndex,
    model: model.id,
    selector: counts.get(model.id.toLowerCase())! > 1 ? `${connectionIndex + 1}:${model.id}` : model.id,
  })));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
