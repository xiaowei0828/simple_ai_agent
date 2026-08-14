import type { AgentRunResult } from "../core/types.js";
import type { AgentRunOptions } from "../core/agent-runner.js";

export interface InteractiveAgent {
  run(task: string, options?: AgentRunOptions): Promise<AgentRunResult>;
}

export interface InteractiveIO {
  prompt(label: string): Promise<string | undefined>;
  writeAssistant(output: string): void;
  writeStatus(output: string): void;
}

export interface InteractiveSessionOptions {
  agent: InteractiveAgent;
  io: InteractiveIO;
  initialTask?: string;
}

const HELP = `Commands:
  /new   Start a new conversation
  /help  Show this help
  /exit  Exit the agent`;

export async function runInteractiveSession(options: InteractiveSessionOptions): Promise<void> {
  let previousResponseId: string | undefined;
  let pendingInput = options.initialTask?.trim() || undefined;

  options.io.writeStatus("Interactive mode. Type /help for commands.");

  while (true) {
    const input = pendingInput ?? await options.io.prompt("agent> ");
    pendingInput = undefined;
    if (input === undefined) return;

    const task = input.trim();
    if (!task) continue;

    switch (task.toLowerCase()) {
      case "/exit":
      case "/quit":
        return;
      case "/new":
        previousResponseId = undefined;
        options.io.writeStatus("Started a new conversation.");
        continue;
      case "/help":
        options.io.writeStatus(HELP);
        continue;
      default:
        if (task.startsWith("/")) {
          options.io.writeStatus(`Unknown command: ${task}. Type /help for commands.`);
          continue;
        }
    }

    try {
      const result = await options.agent.run(task, { previousResponseId });
      previousResponseId = result.responseId;
      options.io.writeAssistant(result.output);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.io.writeStatus(`Request failed: ${message}`);
    }
  }
}
