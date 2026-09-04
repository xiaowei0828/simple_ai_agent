import { stat } from "node:fs/promises";
import path from "node:path";
import { readUtf8Prefix } from "./read-prefix.js";

export const MAX_PROJECT_INSTRUCTION_BYTES = 32 * 1024;

export interface LoadedInstructions {
  files: string[];
  content: string;
  warning?: string;
}

interface InstructionFile {
  content: string;
  truncated: boolean;
}

async function readOptional(filePath: string): Promise<InstructionFile | undefined> {
  try {
    const file = await stat(filePath);
    if (!file.isFile()) return undefined;
    return {
      content: await readUtf8Prefix(filePath, MAX_PROJECT_INSTRUCTION_BYTES),
      truncated: file.size > MAX_PROJECT_INSTRUCTION_BYTES,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function loadProjectInstructions(workspaceRoot: string): Promise<LoadedInstructions> {
  const rootFile = path.join(workspaceRoot, "AGENTS.md");
  const rootInstructions = await readOptional(rootFile);
  if (!rootInstructions) return { files: [], content: "" };

  return {
    files: [rootFile],
    content: rootInstructions.content,
    ...(rootInstructions.truncated
      ? { warning: `AGENTS.md exceeds ${MAX_PROJECT_INSTRUCTION_BYTES} bytes and was truncated.` }
      : {}),
  };
}
