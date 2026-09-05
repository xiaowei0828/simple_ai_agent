import type { ToolDefinition, ToolRisk } from "../core/types.js";

export interface ToolContext {
  workspaceRoot: string;
}

export interface AgentTool<TInput = unknown> {
  definition: ToolDefinition;
  risk: ToolRisk;
  parse(input: unknown): TInput;
  /** Resolve approval-sensitive inputs before asking the host. Must not mutate files. */
  prepare?(input: TInput, context: ToolContext): Promise<TInput>;
  execute(input: TInput, context: ToolContext): Promise<unknown>;
}

export class ToolRegistry {
  readonly #tools = new Map<string, AgentTool<any>>();

  constructor(tools: AgentTool<any>[]) {
    for (const tool of tools) {
      const { name } = tool.definition;
      if (this.#tools.has(name)) {
        throw new Error(`Duplicate tool: ${name}`);
      }
      this.#tools.set(name, tool);
    }
  }

  get(name: string): AgentTool<any> | undefined {
    return this.#tools.get(name);
  }

  definitions(): ToolDefinition[] {
    return [...this.#tools.values()].map((tool) => tool.definition);
  }
}
