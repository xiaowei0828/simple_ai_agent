import { PreviousResponseUnavailableError } from "../core/errors.js";
import type { AgentRunOptions } from "../core/agent-runner.js";
import type { AgentRunResult, ConversationMessage } from "../core/types.js";
import {
  createConversationTitle,
  type Conversation,
  type ConversationStore,
  type ConversationSummary,
} from "../history/conversation-store.js";

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
  historyStore?: ConversationStore;
  viewLatestTrace?: () => Promise<string>;
}

const HELP = `Commands:
  /model                 Show the current and available models
  /model <number|name>   Switch models and start a new conversation
  /history               List saved conversations
  /resume <number|id>    Resume a saved conversation
  /rename <title>        Rename the current conversation
  /trace                 Generate and open the latest trace report
  /new                   Start a new conversation
  /help                  Show this help
  /exit                  Exit the agent`;

export async function runInteractiveSession(options: InteractiveSessionOptions): Promise<void> {
  let previousResponseId: string | undefined;
  let pendingInput = options.initialTask?.trim() || undefined;
  let currentModel = options.initialModel?.trim() || undefined;
  let currentConversation: Conversation | undefined;

  if (!pendingInput && options.historyStore) {
    try {
      const selected = await selectInitialConversation(options.historyStore, options.io);
      if (selected === undefined) return;
      if (selected) {
        currentConversation = selected;
        previousResponseId = selected.lastResponseId;
        currentModel = selected.model;
        options.io.writeStatus(formatResumedConversation(selected));
      }
    } catch (error) {
      options.io.writeStatus(`Unable to load conversation history: ${errorMessage(error)}`);
    }
  }

  let availableModels = uniqueModels(currentModel, options.availableModels ?? []);
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
        currentConversation = undefined;
        previousResponseId = undefined;
        options.io.writeStatus("Started a new conversation.");
        continue;
      case "/history":
        if (!options.historyStore) {
          options.io.writeStatus("Conversation history is unavailable in this session.");
          continue;
        }
        try {
          options.io.writeStatus(formatConversationList(await options.historyStore.list()));
        } catch (error) {
          options.io.writeStatus(`Unable to list conversation history: ${errorMessage(error)}`);
        }
        continue;
      case "/resume": {
        if (!options.historyStore) {
          options.io.writeStatus("Conversation history is unavailable in this session.");
          continue;
        }
        const selector = commandArguments.join(" ").trim();
        if (!selector) {
          options.io.writeStatus("Usage: /resume <number|id>");
          continue;
        }
        try {
          const summaries = await options.historyStore.list();
          const selected = findConversation(summaries, selector);
          if (!selected) {
            options.io.writeStatus(
              `Unknown conversation: ${selector}. Use /history to list saved conversations.`,
            );
            continue;
          }
          currentConversation = await options.historyStore.load(selected.id);
          previousResponseId = currentConversation.lastResponseId;
          currentModel = currentConversation.model;
          availableModels = uniqueModels(currentModel, availableModels);
          options.io.writeStatus(formatResumedConversation(currentConversation));
        } catch (error) {
          options.io.writeStatus(`Unable to resume conversation: ${errorMessage(error)}`);
        }
        continue;
      }
      case "/rename": {
        if (!options.historyStore || !currentConversation) {
          options.io.writeStatus("There is no saved current conversation to rename.");
          continue;
        }
        const title = commandArguments.join(" ").trim();
        if (!title) {
          options.io.writeStatus("Usage: /rename <title>");
          continue;
        }
        try {
          currentConversation = await options.historyStore.rename(currentConversation.id, title);
          options.io.writeStatus(`Renamed conversation to: ${currentConversation.title}`);
        } catch (error) {
          options.io.writeStatus(`Unable to rename conversation: ${errorMessage(error)}`);
        }
        continue;
      }
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
        currentConversation = undefined;
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
          options.io.writeStatus(`Trace view failed: ${errorMessage(error)}`);
        }
        continue;
      default:
        if (task.startsWith("/")) {
          options.io.writeStatus(`Unknown command: ${task}. Type /help for commands.`);
          continue;
        }
    }

    try {
      const history = currentConversation && !previousResponseId
        ? toConversationMessages(currentConversation)
        : undefined;
      let result: AgentRunResult;
      try {
        result = await options.agent.run(task, {
          previousResponseId,
          ...(history?.length ? { history } : {}),
          ...(currentModel ? { model: currentModel } : {}),
        });
      } catch (error) {
        if (!(error instanceof PreviousResponseUnavailableError) || !currentConversation) {
          throw error;
        }
        options.io.writeStatus(
          "The remote conversation is unavailable. Replaying the saved local transcript.",
        );
        result = await options.agent.run(task, {
          history: toConversationMessages(currentConversation),
          ...(currentModel ? { model: currentModel } : {}),
        });
      }

      previousResponseId = result.responseId;
      options.io.writeAssistant(result.output);

      if (options.historyStore && currentModel) {
        const turn = {
          user: task,
          assistant: result.output,
          responseId: result.responseId,
          createdAt: new Date().toISOString(),
        };
        try {
          currentConversation = currentConversation
            ? await options.historyStore.appendTurn(currentConversation.id, turn)
            : await options.historyStore.create({
              model: currentModel,
              title: createConversationTitle(task),
              firstTurn: turn,
            });
        } catch (error) {
          options.io.writeStatus(`Unable to save conversation history: ${errorMessage(error)}`);
        }
      }
    } catch (error) {
      options.io.writeStatus(`Request failed: ${errorMessage(error)}`);
    }
  }
}

async function selectInitialConversation(
  store: ConversationStore,
  io: InteractiveIO,
): Promise<Conversation | null | undefined> {
  const summaries = await store.list();
  if (summaries.length === 0) return null;

  io.writeStatus(formatConversationList(summaries));
  while (true) {
    const input = await io.prompt("Select conversation [0=new]: ");
    if (input === undefined) return undefined;
    const selector = input.trim();
    if (!selector || selector === "0" || selector.toLowerCase() === "new") return null;

    const selected = findConversation(summaries, selector);
    if (selected) return store.load(selected.id);
    io.writeStatus(`Unknown conversation: ${selector}. Enter a listed number, ID, or 0.`);
  }
}

function findConversation(
  conversations: ConversationSummary[],
  selector: string,
): ConversationSummary | undefined {
  if (/^\d+$/u.test(selector)) {
    return conversations[Number(selector) - 1];
  }
  const normalized = selector.toLowerCase();
  const matches = conversations.filter((conversation) =>
    conversation.id.toLowerCase().startsWith(normalized)
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function formatConversationList(conversations: ConversationSummary[]): string {
  if (conversations.length === 0) return "No saved conversations.";
  const entries = conversations.map((conversation, index) =>
    `  ${index + 1}. ${conversation.title} [${conversation.model}] `
      + `${formatTimestamp(conversation.updatedAt)} (${conversation.turnCount} turn(s), `
      + `${conversation.id.slice(0, 8)})`
  );
  return ["Saved conversations:", ...entries, "Use /resume <number|id> to continue."].join("\n");
}

function formatResumedConversation(conversation: Conversation): string {
  const visibleTurns = conversation.turns.slice(-10);
  const omitted = conversation.turns.length - visibleTurns.length;
  const transcript = visibleTurns.flatMap((turn) => [
    `user> ${turn.user}`,
    `assistant> ${turn.assistant}`,
  ]);
  return [
    `Resumed conversation: ${conversation.title} [${conversation.model}]`,
    ...(omitted > 0 ? [`… ${omitted} earlier turn(s) omitted from display.`] : []),
    ...transcript,
  ].join("\n\n");
}

function toConversationMessages(conversation: Conversation): ConversationMessage[] {
  return conversation.turns.flatMap((turn) => [
    { role: "user" as const, content: turn.user },
    { role: "assistant" as const, content: turn.assistant },
  ]);
}

function formatTimestamp(timestamp: string): string {
  return timestamp.replace("T", " ").replace(/:\d{2}\.\d{3}Z$/u, "Z");
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
