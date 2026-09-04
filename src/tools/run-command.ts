import { stat } from "node:fs/promises";
import { z } from "zod";
import { resolveExistingWorkspacePath } from "../policy/path-policy.js";
import { resolveRuntimeShell, runProcess } from "./process-runner.js";
import type { AgentTool } from "./types.js";

const inputSchema = z.object({
  command: z.string().trim().min(1).max(30_000),
  cwd: z.string().min(1).default("."),
  timeoutMs: z.number().int().min(1_000).max(900_000).default(120_000),
}).strict();

export function createRunCommandTool(): AgentTool<z.infer<typeof inputSchema>> {
  const shell = resolveRuntimeShell();
  return {
    risk: "execute",
    definition: {
      type: "function",
      name: "run_command",
      description:
        `Run a command string in non-interactive ${shell.displayName}. Shell operators such as pipelines, redirects, and command chaining are evaluated by the shell. Use it for file reads, directory listings, file discovery, text searches, builds, tests, version control, and other commands. Read small files with cat and line ranges with sed -n (Get-Content with Select-Object in PowerShell). Prefer rg for text searches and rg --files for file discovery. Every invocation requires host approval.`,
      strict: true,
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: `Complete ${shell.displayName} command string. Shell syntax is supported.`,
          },
          cwd: {
            type: "string",
            description: "Workspace-relative working directory, usually '.'.",
          },
          timeoutMs: {
            type: "integer",
            minimum: 1_000,
            maximum: 900_000,
            description: "Timeout in milliseconds.",
          },
        },
        required: ["command", "cwd", "timeoutMs"],
        additionalProperties: false,
      },
    },
    parse: (input) => inputSchema.parse(input),
    async execute(input, context) {
      const cwd = await resolveExistingWorkspacePath(context.workspaceRoot, input.cwd);
      if (!(await stat(cwd)).isDirectory()) throw new Error("run_command cwd must be a directory.");

      return runProcess({
        command: input.command,
        cwd,
        timeoutMs: input.timeoutMs,
      });
    },
  };
}
