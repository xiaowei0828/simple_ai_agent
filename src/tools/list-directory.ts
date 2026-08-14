import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveExistingWorkspacePath, toWorkspaceRelative } from "../policy/path-policy.js";
import { IGNORED_DIRECTORIES } from "./files.js";
import type { AgentTool } from "./types.js";

const inputSchema = z.object({
  path: z.string().min(1),
  depth: z.number().int().min(1).max(5),
  maxResults: z.number().int().min(1).max(500),
}).strict();

type DirectoryEntryType = "directory" | "file" | "symlink" | "other";
interface ListedEntry {
  path: string;
  type: DirectoryEntryType;
}

export function createListDirectoryTool(): AgentTool<z.infer<typeof inputSchema>> {
  return {
    risk: "read",
    definition: {
      type: "function",
      name: "list_directory",
      description:
        "List files and directories under one workspace-relative directory. Use depth=1 for the immediate level; increase depth only when recursive filename discovery is necessary. Build and dependency directories are ignored.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Workspace-relative directory, such as '.' or 'src'.",
          },
          depth: {
            type: "integer",
            minimum: 1,
            maximum: 5,
            description: "Number of directory levels to include. Use 1 for an immediate listing.",
          },
          maxResults: {
            type: "integer",
            minimum: 1,
            maximum: 500,
            description: "Maximum number of entries to return across all included levels.",
          },
        },
        required: ["path", "depth", "maxResults"],
        additionalProperties: false,
      },
    },
    parse: (input) => inputSchema.parse(input),
    async execute(input, context) {
      const directory = await resolveExistingWorkspacePath(context.workspaceRoot, input.path);
      if (!(await stat(directory)).isDirectory()) {
        throw new Error("list_directory only accepts directories.");
      }

      const entries: ListedEntry[] = [];
      let truncated = false;

      async function visit(currentDirectory: string, level: number): Promise<void> {
        if (truncated) return;
        const children = (await readdir(currentDirectory, { withFileTypes: true }))
          .filter((entry) => !shouldIgnoreEntry(entry.name, entry.isDirectory()))
          .map((entry) => ({
            name: entry.name,
            type: entryType(entry),
          }))
          .sort((left, right) => {
            const typeOrder = entryOrder(left.type) - entryOrder(right.type);
            return typeOrder || left.name.localeCompare(right.name);
          });

        for (const child of children) {
          if (entries.length >= input.maxResults) {
            truncated = true;
            return;
          }
          entries.push({
            path: toWorkspaceRelative(context.workspaceRoot, path.join(currentDirectory, child.name)),
            type: child.type,
          });
        }

        if (level >= input.depth) return;
        for (const child of children) {
          if (child.type !== "directory") continue;
          await visit(path.join(currentDirectory, child.name), level + 1);
          if (truncated) return;
        }
      }

      await visit(directory, 1);

      return {
        path: toWorkspaceRelative(context.workspaceRoot, directory),
        depth: input.depth,
        entries,
        returnedEntries: entries.length,
        truncated,
      };
    },
  };
}

function shouldIgnoreEntry(name: string, isDirectory: boolean): boolean {
  if (name.startsWith(".env") || name === ".DS_Store") return true;
  return isDirectory && IGNORED_DIRECTORIES.has(name);
}

function entryType(entry: {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): DirectoryEntryType {
  if (entry.isDirectory()) return "directory";
  if (entry.isFile()) return "file";
  if (entry.isSymbolicLink()) return "symlink";
  return "other";
}

function entryOrder(type: DirectoryEntryType): number {
  if (type === "directory") return 0;
  if (type === "file") return 1;
  if (type === "symlink") return 2;
  return 3;
}
