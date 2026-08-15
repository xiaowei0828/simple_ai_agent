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
  initialModel?: string;
  availableModels?: string[];
  viewLatestTrace?: () => Promise<string>;
}

const HELP = `Commands:
  /model                 Show the current and available models
  /model <number|name>   Switch models and start a new conversation
  /trace                 Generate and open the latest trace report
  /new                   Start a new conversation
  /help                  Show this help
  /exit                  Exit the agent`;

export async function runInteractiveSession(options: InteractiveSessionOptions): Promise<void> {
  let previousResponseId: string | undefined;
  let pendingInput = options.initialTask?.trim() || undefined;
  let currentModel = options.initialModel?.trim() || undefined;
  const availableModels = uniqueModels(currentModel, options.availableModels ?? []);

  options.io.writeStatus(
    `Interactive mode.${currentModel ? ` Model: ${currentModel}.` : ""} Type /help for commands.`,
  );

  while (true) {
    const input = pendingInput ?? await options.io.prompt("agent> ");
    pendingInput = undefined;
    if (input === undefined) return;

    const task = input.trim();
    if (!task) continue;

    const [command = "", ...commandArguments] = task.split(/\s+/u);
    switch (command.toLowerCase()) {
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
      case "/model": {
        const selector = commandArguments.join(" ").trim();
        if (!selector) {
          options.io.writeStatus(formatModelList(availableModels, currentModel));
          continue;
        }
        const selectedModel = findModel(availableModels, selector);
        if (!selectedModel) {
          options.io.writeStatus(
            `Unknown model: ${selector}. Use /model to list configured models.`,
          );
          continue;
        }
        if (selectedModel === currentModel) {
          options.io.writeStatus(`Already using model: ${selectedModel}.`);
          continue;
        }
        currentModel = selectedModel;
        previousResponseId = undefined;
        options.io.writeStatus(`Switched to model: ${selectedModel}. Started a new conversation.`);
        continue;
      }
      case "/trace":
        if (commandArguments.length > 0) {
          options.io.writeStatus("Usage: /trace");
          continue;
        }
        if (!options.viewLatestTrace) {
          options.io.writeStatus("Trace viewing is unavailable in this session.");
          continue;
        }
        try {
          const reportPath = await options.viewLatestTrace();
          options.io.writeStatus(`Opened trace report: ${reportPath}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          options.io.writeStatus(`Trace view failed: ${message}`);
        }
        continue;
      default:
        if (task.startsWith("/")) {
          options.io.writeStatus(`Unknown command: ${task}. Type /help for commands.`);
          continue;
        }
    }

    try {
      const result = await options.agent.run(task, {
        previousResponseId,
        ...(currentModel ? { model: currentModel } : {}),
      });
      previousResponseId = result.responseId;
      options.io.writeAssistant(result.output);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.io.writeStatus(`Request failed: ${message}`);
    }
  }
}

function uniqueModels(currentModel: string | undefined, configuredModels: string[]): string[] {
  const models = [...new Set(configuredModels.map((model) => model.trim()).filter(Boolean))];
  if (currentModel && !models.includes(currentModel)) models.unshift(currentModel);
  return models;
}

function findModel(models: string[], selector: string): string | undefined {
  if (/^\d+$/u.test(selector)) {
    const index = Number(selector) - 1;
    return models[index];
  }
  const normalized = selector.toLowerCase();
  return models.find((model) => model.toLowerCase() === normalized);
}

function formatModelList(models: string[], currentModel: string | undefined): string {
  if (models.length === 0) {
    return "No models are configured.";
  }
  const entries = models.map((model, index) => {
    const marker = model === currentModel ? "*" : " ";
    return `  ${marker} ${index + 1}. ${model}`;
  });
  return [
    `Current model: ${currentModel ?? "not selected"}`,
    "Available models:",
    ...entries,
    "Use /model <number|name> to switch.",
  ].join("\n");
}
