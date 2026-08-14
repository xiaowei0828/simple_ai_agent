import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { resolveExistingWorkspacePath } from "../policy/path-policy.js";
import type { AgentTool } from "./types.js";

const inputSchema = z.object({
  path: z.string().min(1),
  lineStart: z.number().int().positive().nullable().default(null),
  lineEnd: z.number().int().positive().nullable().default(null),
}).strict();

const MAX_FILE_BYTES = 1_000_000;
const MAX_RESULT_CHARS = 30_000;

export function createReadFileTool(): AgentTool<z.infer<typeof inputSchema>> {
  return {
    risk: "read",
    definition: {
      type: "function",
      name: "read_file",
      description: "Read a UTF-8 text file, optionally selecting an inclusive one-based line range.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          lineStart: { type: ["integer", "null"], minimum: 1 },
          lineEnd: { type: ["integer", "null"], minimum: 1 },
        },
        required: ["path", "lineStart", "lineEnd"],
        additionalProperties: false,
      },
    },
    parse: (input) => {
      const parsed = inputSchema.parse(input);
      if (parsed.lineStart !== null && parsed.lineEnd !== null && parsed.lineEnd < parsed.lineStart) {
        throw new Error("lineEnd must be greater than or equal to lineStart.");
      }
      return parsed;
    },
    async execute(input, context) {
      const filePath = await resolveExistingWorkspacePath(context.workspaceRoot, input.path);
      const metadata = await stat(filePath);
      if (!metadata.isFile()) throw new Error("read_file only accepts files.");
      if (metadata.size > MAX_FILE_BYTES) throw new Error(`File exceeds ${MAX_FILE_BYTES} bytes.`);

      const text = await readFile(filePath, "utf8");
      if (text.includes("\0")) throw new Error("Binary files are not supported.");
      const lines = text.split("\n");
      const start = input.lineStart ?? 1;
      const end = input.lineEnd ?? lines.length;
      const selected = lines.slice(start - 1, end).join("\n");
      return {
        path: input.path,
        lineStart: start,
        lineEnd: Math.min(end, lines.length),
        content: selected.slice(0, MAX_RESULT_CHARS),
        truncated: selected.length > MAX_RESULT_CHARS,
      };
    },
  };
}
