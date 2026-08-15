import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const commandAllowlistSchema = z.object({
  version: z.literal(1),
  programs: z.array(z.string().trim().min(1)),
}).strict();

export type CommandAllowlist = z.infer<typeof commandAllowlistSchema>;

export function resolveCommandAllowlistPath(cwd: string = process.cwd()): string {
  return path.resolve(cwd, ".config", "command-allowlist.json");
}

export async function loadCommandAllowlist(filePath: string): Promise<CommandAllowlist> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return { version: 1, programs: [] };
    throw new Error(`Unable to read command allowlist '${filePath}': ${errorMessage(error)}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Invalid JSON in command allowlist '${filePath}': ${errorMessage(error)}`);
  }

  const result = commandAllowlistSchema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "allowlist"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid command allowlist '${filePath}': ${details}`);
  }
  return normalizeCommandAllowlist(result.data);
}

export async function saveCommandAllowlist(
  filePath: string,
  allowlist: CommandAllowlist,
): Promise<void> {
  const normalized = normalizeCommandAllowlist(commandAllowlistSchema.parse(allowlist));
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!isFileSystemError(error, "ENOENT")) throw error;
    });
  }
}

export class CommandAllowlistStore {
  readonly #filePath: string;
  #programs: Set<string>;

  private constructor(filePath: string, allowlist: CommandAllowlist) {
    this.#filePath = filePath;
    this.#programs = new Set(allowlist.programs);
  }

  static async load(filePath: string): Promise<CommandAllowlistStore> {
    return new CommandAllowlistStore(filePath, await loadCommandAllowlist(filePath));
  }

  hasProgram(program: string): boolean {
    return this.#programs.has(program);
  }

  listPrograms(): string[] {
    return [...this.#programs];
  }

  async addProgram(program: string): Promise<boolean> {
    return (await this.addPrograms([program])).length > 0;
  }

  async addPrograms(programsToAdd: string[]): Promise<string[]> {
    const additions = [...new Set(programsToAdd.map((program) => program.trim()).filter(Boolean))]
      .filter((program) => !this.#programs.has(program));
    if (additions.length === 0) return [];

    const current = await loadCommandAllowlist(this.#filePath);
    const programs = [...new Set([...current.programs, ...additions])];
    await saveCommandAllowlist(this.#filePath, { version: 1, programs });
    this.#programs = new Set(programs);
    return additions;
  }
}

function normalizeCommandAllowlist(allowlist: CommandAllowlist): CommandAllowlist {
  return {
    version: 1,
    programs: [...new Set(allowlist.programs.map((program) => program.trim()).filter(Boolean))],
  };
}

function isFileSystemError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
