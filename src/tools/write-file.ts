import { lstat, writeFile } from "node:fs/promises";
import { z } from "zod";
import { resolveWorkspacePathForMutation } from "../policy/path-policy.js";
import type { AgentTool } from "./types.js";

const MAX_CONTENT_BYTES = 1_000_000;

const inputSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  overwrite: z.boolean().default(false),
}).strict();

export function createWriteFileTool(): AgentTool<z.infer<typeof inputSchema>> {
  return {
    risk: "write",
    definition: {
      type: "function",
      name: "write_file",
      description:
        "Write the complete UTF-8 content of one workspace file. Parent directories must already exist. Set overwrite to false when creating a new file; replacing an existing file requires overwrite=true.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative file path." },
          content: { type: "string", description: "Complete UTF-8 file content, including any desired final newline." },
          overwrite: {
            type: "boolean",
            description: "False to require a new file; true to allow replacing an existing regular file.",
          },
        },
        required: ["path", "content", "overwrite"],
        additionalProperties: false,
      },
    },
    parse: (input) => {
      const parsed = inputSchema.parse(input);
      const bytes = Buffer.byteLength(parsed.content, "utf8");
      if (bytes > MAX_CONTENT_BYTES) {
        throw new Error(`Content exceeds ${MAX_CONTENT_BYTES} UTF-8 bytes.`);
      }
      return parsed;
    },
    async execute(input, context) {
      const filePath = await resolveWorkspacePathForMutation(context.workspaceRoot, input.path);
      let existing: Awaited<ReturnType<typeof lstat>> | undefined;
      try {
        existing = await lstat(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      if (existing) {
        if (existing.isSymbolicLink()) throw new Error("write_file does not overwrite symbolic links.");
        if (!existing.isFile()) throw new Error("write_file only accepts regular files.");
        if (!input.overwrite) {
          throw new Error("File already exists. Read it first, then set overwrite=true only if full replacement is intended.");
        }
      }

      await writeFile(filePath, input.content, {
        encoding: "utf8",
        flag: existing ? "w" : "wx",
      });
      return {
        path: input.path,
        created: !existing,
        overwritten: Boolean(existing),
        bytesWritten: Buffer.byteLength(input.content, "utf8"),
      };
    },
  };
}
