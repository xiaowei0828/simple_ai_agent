import { readFile, stat, writeFile } from "node:fs/promises";
import { z } from "zod";
import { resolveExistingWorkspacePath } from "../policy/path-policy.js";
import type { AgentTool } from "./types.js";

const inputSchema = z.object({
  path: z.string().min(1),
  oldText: z.string().min(1),
  newText: z.string(),
  expectedOccurrences: z.number().int().min(1).max(100),
}).strict();

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = text.indexOf(needle, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + needle.length;
  }
}

export function createReplaceInFileTool(): AgentTool<z.infer<typeof inputSchema>> {
  return {
    risk: "write",
    definition: {
      type: "function",
      name: "replace_in_file",
      description: "Replace exact text in one existing workspace file. The edit fails unless the occurrence count matches the expectation.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          oldText: { type: "string", minLength: 1 },
          newText: { type: "string" },
          expectedOccurrences: { type: "integer", minimum: 1, maximum: 100 },
        },
        required: ["path", "oldText", "newText", "expectedOccurrences"],
        additionalProperties: false,
      },
    },
    parse: (input) => inputSchema.parse(input),
    async execute(input, context) {
      const filePath = await resolveExistingWorkspacePath(context.workspaceRoot, input.path);
      const metadata = await stat(filePath);
      if (!metadata.isFile()) throw new Error("replace_in_file only accepts files.");

      const current = await readFile(filePath, "utf8");
      const occurrences = countOccurrences(current, input.oldText);
      if (occurrences !== input.expectedOccurrences) {
        throw new Error(
          `Expected ${input.expectedOccurrences} occurrence(s), but found ${occurrences}. No changes were made.`,
        );
      }

      const updated = current.split(input.oldText).join(input.newText);
      await writeFile(filePath, updated, "utf8");
      return {
        path: input.path,
        replacements: occurrences,
        bytesBefore: Buffer.byteLength(current),
        bytesAfter: Buffer.byteLength(updated),
      };
    },
  };
}
