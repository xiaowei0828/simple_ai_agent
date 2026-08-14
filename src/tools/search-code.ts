import { readFile } from "node:fs/promises";
import { z } from "zod";
import { resolveExistingWorkspacePath, toWorkspaceRelative } from "../policy/path-policy.js";
import { isLikelyTextFile, walkFiles } from "./files.js";
import type { AgentTool } from "./types.js";

const inputSchema = z.object({
  query: z.string().min(1).max(500),
  path: z.string().min(1),
  maxResults: z.number().int().min(1).max(200),
}).strict();

export function createSearchCodeTool(): AgentTool<z.infer<typeof inputSchema>> {
  return {
    risk: "read",
    definition: {
      type: "function",
      name: "search_code",
      description: "Search text files for a literal, case-sensitive string and return matching lines.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1 },
          path: { type: "string", description: "Workspace-relative search directory." },
          maxResults: { type: "integer", minimum: 1, maximum: 200 },
        },
        required: ["query", "path", "maxResults"],
        additionalProperties: false,
      },
    },
    parse: (input) => inputSchema.parse(input),
    async execute(input, context) {
      const directory = await resolveExistingWorkspacePath(context.workspaceRoot, input.path);
      const files = await walkFiles(directory, 5_000);
      const matches: Array<{ path: string; line: number; text: string }> = [];

      for (const file of files) {
        if (!isLikelyTextFile(file)) continue;
        let text: string;
        try {
          text = await readFile(file, "utf8");
        } catch {
          continue;
        }
        const lines = text.split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? "";
          if (line.includes(input.query)) {
            matches.push({
              path: toWorkspaceRelative(context.workspaceRoot, file),
              line: index + 1,
              text: line.slice(0, 500),
            });
            if (matches.length >= input.maxResults) {
              return { matches, truncated: true };
            }
          }
        }
      }
      return { matches, truncated: false };
    },
  };
}
