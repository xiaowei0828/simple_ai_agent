import { lstat, unlink } from "node:fs/promises";
import { z } from "zod";
import { resolveWorkspacePathForMutation } from "../policy/path-policy.js";
import type { AgentTool } from "./types.js";

const inputSchema = z.object({
  path: z.string().min(1),
}).strict();

export function createDeleteFileTool(): AgentTool<z.infer<typeof inputSchema>> {
  return {
    risk: "write",
    definition: {
      type: "function",
      name: "delete_file",
      description:
        "Delete one regular file or symbolic link inside the workspace. Directories are not supported. This operation requires host approval.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Workspace-relative path of the file or symbolic link to delete." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    parse: (input) => inputSchema.parse(input),
    async execute(input, context) {
      const filePath = await resolveWorkspacePathForMutation(context.workspaceRoot, input.path);
      const metadata = await lstat(filePath);
      const entryType = metadata.isSymbolicLink() ? "symbolic_link" : "file";
      if (!metadata.isFile() && !metadata.isSymbolicLink()) {
        throw new Error("delete_file only accepts regular files or symbolic links. Directories are not supported.");
      }

      await unlink(filePath);
      return {
        path: input.path,
        deleted: true,
        entryType,
        bytesBefore: metadata.size,
      };
    },
  };
}
