import { createApplyPatchTool } from "./apply-patch.js";
import { createRunCommandTool } from "./run-command.js";
import { ToolRegistry } from "./types.js";

export function createDefaultToolRegistry(): ToolRegistry {
  return new ToolRegistry([
    createApplyPatchTool(),
    createRunCommandTool(),
  ]);
}

export { ToolRegistry } from "./types.js";
export type { AgentTool, ToolContext } from "./types.js";
