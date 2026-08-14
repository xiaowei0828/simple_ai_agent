import type { SkillMetadata } from "../context/skill-registry.js";
import { createDeleteFileTool } from "./delete-file.js";
import { createListDirectoryTool } from "./list-directory.js";
import { createLoadSkillTool } from "./load-skill.js";
import { createReadFileTool } from "./read-file.js";
import { createReplaceInFileTool } from "./replace-in-file.js";
import { createRunCommandTool } from "./run-command.js";
import { createSearchCodeTool } from "./search-code.js";
import { createWriteFileTool } from "./write-file.js";
import { ToolRegistry, type AgentTool } from "./types.js";

export function createDefaultToolRegistry(skills: SkillMetadata[] = []): ToolRegistry {
  const tools: AgentTool<any>[] = [
    createListDirectoryTool(),
    createReadFileTool(),
    createSearchCodeTool(),
    createWriteFileTool(),
    createReplaceInFileTool(),
    createDeleteFileTool(),
    createRunCommandTool(),
  ];
  if (skills.length > 0) tools.push(createLoadSkillTool(skills));
  return new ToolRegistry(tools);
}

export { ToolRegistry } from "./types.js";
export type { AgentTool, ToolContext } from "./types.js";
