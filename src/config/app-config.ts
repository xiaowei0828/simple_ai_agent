import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const DEFAULT_MODEL = "deepseek-v4-flash";
export const DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/plan/v3";

const appConfigSchema = z.object({
  apiKey: z.string(),
  baseUrl: z.string().url(),
  models: z.object({
    default: z.string().trim().min(1),
    available: z.array(z.string().trim().min(1)).min(1),
  }).strict(),
}).strict().superRefine((config, context) => {
  if (!config.models.available.includes(config.models.default)) {
    context.addIssue({
      code: "custom",
      path: ["models", "default"],
      message: "must also appear in models.available",
    });
  }
});

export type AppConfig = z.infer<typeof appConfigSchema>;

export interface RuntimeModelConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export const DEFAULT_APP_CONFIG: AppConfig = {
  apiKey: "",
  baseUrl: DEFAULT_BASE_URL,
  models: {
    default: DEFAULT_MODEL,
    available: [DEFAULT_MODEL],
  },
};

export function resolveAppConfigPath(cwd: string = process.cwd()): string {
  return path.resolve(cwd, ".config", "config.json");
}

export async function loadAppConfig(configPath: string): Promise<AppConfig> {
  let contents: string;
  try {
    contents = await readFile(configPath, "utf8");
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return DEFAULT_APP_CONFIG;
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
  overrides: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  } = {},
): RuntimeModelConfig {
  return {
    apiKey: nonEmpty(overrides.apiKey) ?? config.apiKey.trim(),
    baseUrl: nonEmpty(overrides.baseUrl) ?? config.baseUrl,
    model: nonEmpty(overrides.model) ?? config.models.default,
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isFileSystemError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
