import { readFile } from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "../policy/path-policy.js";

const MAX_INSTRUCTION_CHARS = 60_000;

export interface LoadedInstructions {
  files: string[];
  content: string;
}

async function readOptional(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function loadProjectInstructions(
  workspaceRoot: string,
  workingDirectory = workspaceRoot,
): Promise<LoadedInstructions> {
  const relativeWorkingDirectory = path.relative(workspaceRoot, workingDirectory);
  if (!isPathInside(workspaceRoot, workingDirectory)) {
    throw new Error("workingDirectory must be inside workspaceRoot.");
  }

  const directories = [workspaceRoot];
  let current = workspaceRoot;
  for (const segment of relativeWorkingDirectory.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    directories.push(current);
  }

  const sections: string[] = [];
  const files: string[] = [];
  for (const directory of directories) {
    const overridePath = path.join(directory, "AGENTS.override.md");
    const standardPath = path.join(directory, "AGENTS.md");
    const override = await readOptional(overridePath);
    const selectedPath = override === undefined ? standardPath : overridePath;
    const content = override ?? await readOptional(standardPath);
    if (content === undefined) continue;

    files.push(selectedPath);
    sections.push(`## Instructions from ${path.relative(workspaceRoot, selectedPath) || path.basename(selectedPath)}\n\n${content}`);
  }

  const content = sections.join("\n\n").slice(0, MAX_INSTRUCTION_CHARS);
  return { files, content };
}
