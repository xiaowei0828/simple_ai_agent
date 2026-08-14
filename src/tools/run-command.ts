import { stat } from "node:fs/promises";
import { z } from "zod";
import { assertCommandAllowed, formatCommand } from "../policy/command-policy.js";
import { resolveExistingWorkspacePath, toWorkspaceRelative } from "../policy/path-policy.js";
import { runProcess } from "./process-runner.js";
import type { AgentTool } from "./types.js";

const inputSchema = z.object({
  program: z.string().trim().min(1).max(500),
  args: z.array(z.string().max(10_000)).max(100).default([]),
  cwd: z.string().min(1).default("."),
  timeoutMs: z.number().int().min(1_000).max(900_000).default(120_000),
}).strict();

export function createRunCommandTool(): AgentTool<z.infer<typeof inputSchema>> {
  return {
    risk: "execute",
    definition: {
      type: "function",
      name: "run_command",
      description:
        "Run one program with structured arguments inside the workspace. Use it for builds, tests, version control, and other commands not covered by a structured tool. Shell operators and destructive commands are not supported.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          program: {
            type: "string",
            description: "Executable name or path, such as 'cmake', 'npm', or './configure'.",
          },
          args: {
            type: "array",
            items: { type: "string" },
            description: "Arguments passed directly to the executable without shell parsing.",
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
        required: ["program", "args", "cwd", "timeoutMs"],
        additionalProperties: false,
      },
    },
    parse: (input) => {
      const parsed = inputSchema.parse(input);
      assertCommandAllowed(parsed.program, parsed.args);
      return parsed;
    },
    async execute(input, context) {
      assertCommandAllowed(input.program, input.args);
      const cwd = await resolveExistingWorkspacePath(context.workspaceRoot, input.cwd);
      if (!(await stat(cwd)).isDirectory()) throw new Error("run_command cwd must be a directory.");

      const result = await runProcess({
        program: input.program,
        args: input.args,
        cwd,
        timeoutMs: input.timeoutMs,
      });
      return {
        command: formatCommand(input.program, input.args),
        cwd: toWorkspaceRelative(context.workspaceRoot, cwd),
        ...result,
      };
    },
  };
}
