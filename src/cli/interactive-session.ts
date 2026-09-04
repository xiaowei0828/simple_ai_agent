import type { AgentRunOptions } from "../core/agent-runner.js";
import type { AgentRunResult, CompactionResult, ReasoningEffort } from "../core/types.js";
import {
  createConversationTitle,
  replayConversation,
  type Conversation,
  type ConversationStore,
  type ConversationSummary,
} from "../history/session-store.js";

export interface InteractiveAgent {
  run(task: string, options?: AgentRunOptions): Promise<AgentRunResult>;
  compact?(options: AgentRunOptions, customInstructions?: string): Promise<CompactionResult | undefined>;
}

export interface InteractiveIO {
  prompt(label: string): Promise<string | undefined>;
  writeAssistant(output: string): void;
  writeStatus(output: string): void;
}

export interface InteractiveSessionOptions {
  agent: InteractiveAgent;
  io: InteractiveIO;
  initialModel: string;
  availableModels?: string[];
  reasoningConfig?: (model: string) => {
    reasoningEffort: ReasoningEffort;
    supportedReasoningEfforts: readonly ReasoningEffort[];
  };
  historyStore: ConversationStore;
  viewLatestTrace?: (conversationId?: string) => Promise<string>;
}

const HELP = `Commands:
  /model                 Show the current and available models
  /model <number|name>   Switch models and start a new conversation
  /reasoning             Show the current and supported reasoning efforts
  /reasoning <effort>    Change reasoning effort for this conversation
  /history               List saved conversations
  /resume <number|id>    Resume a saved conversation
  /rename <title>        Rename the current conversation
  /trace                 Generate and open the current session trace report
  /compact [focus]       Summarize older history while retaining recent work
  /new                   Start a new conversation
  /help                  Show this help
  /exit                  Exit the agent`;

export async function runInteractiveSession(options: InteractiveSessionOptions): Promise<void> {
  // Resume always replays local context; only responses from this run can seed continuation.
  let previousResponseId: string | undefined;
  let currentModel = options.initialModel;
  let currentConversation: Conversation | undefined;

  try {
    const selected = await selectInitialConversation(options.historyStore, options.io);
    if (selected === undefined) return;
    if (selected) {
      currentConversation = selected;
      currentModel = selected.model;
      options.io.writeStatus(formatResumedConversation(selected));
    }
  } catch (error) {
    options.io.writeStatus(`Unable to load conversation history: ${errorMessage(error)}`);
  }

  let currentReasoningEffort = restoreReasoningEffort();
  let availableModels = uniqueModels(currentModel, options.availableModels ?? []);
  options.io.writeStatus(
    `Interactive mode. Model: ${currentModel}.${currentReasoningEffort ? ` Reasoning: ${currentReasoningEffort}.` : ""} Type /help for commands.`,
  );

  function restoreReasoningEffort(): ReasoningEffort | undefined {
    try {
      const config = options.reasoningConfig?.(currentModel);
      const saved = currentConversation?.reasoningEffort;
      if (!config) return saved;
      if (saved && config.supportedReasoningEfforts.includes(saved)) return saved;
      if (saved) options.io.writeStatus(`Saved reasoning effort '${saved}' is unavailable for ${currentModel}; using ${config.reasoningEffort}.`);
      return config.reasoningEffort;
    } catch (error) {
      options.io.writeStatus(`Unable to load reasoning settings: ${errorMessage(error)}`);
      return undefined;
    }
  }

  async function saveReasoningEffort(): Promise<void> {
    if (currentConversation && currentReasoningEffort && currentConversation.reasoningEffort !== currentReasoningEffort) {
      currentConversation = await options.historyStore.setReasoningEffort(currentConversation.id, currentReasoningEffort);
    }
  }

  while (true) {
    const input = await options.io.prompt("agent> ");
    if (input === undefined) return;

    const task = input.trim();
    if (!task) continue;

    const [command = "", ...commandArguments] = task.split(/\s+/u);
    const commandArgument = commandArguments.join(" ");
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
        try {
          options.io.writeStatus(formatConversationList(await options.historyStore.list()));
        } catch (error) {
          options.io.writeStatus(`Unable to list conversation history: ${errorMessage(error)}`);
        }
        continue;
      case "/resume": {
        const selector = commandArgument;
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
          previousResponseId = undefined;
          currentModel = currentConversation.model;
          currentReasoningEffort = restoreReasoningEffort();
          availableModels = uniqueModels(currentModel, availableModels);
          options.io.writeStatus(formatResumedConversation(currentConversation));
        } catch (error) {
          options.io.writeStatus(`Unable to resume conversation: ${errorMessage(error)}`);
        }
        continue;
      }
      case "/rename": {
        if (!currentConversation) {
          options.io.writeStatus("There is no saved current conversation to rename.");
          continue;
        }
        const title = commandArgument;
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
      case "/compact": {
        if (!currentConversation) {
          options.io.writeStatus("There is no saved current conversation to compact.");
          continue;
        }
        if (!options.agent.compact) {
          options.io.writeStatus("Compaction is unavailable in this session.");
          continue;
        }
        try {
          await saveReasoningEffort();
          options.historyStore.beginCompaction(currentConversation.id);
          const result = await options.agent.compact({
            model: currentModel, history: replayConversation(currentConversation),
            reasoningEffort: currentReasoningEffort,
            summary: currentConversation.summary, contextUsage: currentConversation.contextUsage,
          }, commandArgument || undefined);
          if (result) {
            previousResponseId = undefined;
            currentConversation = await options.historyStore.load(currentConversation.id);
          } else {
            options.io.writeStatus("No older complete message group is available to compact.");
          }
        } catch (error) {
          previousResponseId = undefined;
          // A checkpoint may have committed before a later reporting error.
          try { currentConversation = await options.historyStore.load(currentConversation.id); }
          catch (loadError) { options.io.writeStatus(`Unable to reload conversation: ${errorMessage(loadError)}`); }
          options.io.writeStatus(`Compaction failed: ${errorMessage(error)}`);
        } finally {
          options.historyStore.endCompaction();
        }
        continue;
      }
      case "/reasoning": {
        try {
          const config = options.reasoningConfig?.(currentModel);
          if (!config) {
            options.io.writeStatus("Reasoning selection is unavailable in this session.");
            continue;
          }
          const selector = commandArgument.toLowerCase();
          if (!selector) {
            options.io.writeStatus(`Reasoning effort: ${currentReasoningEffort}. Supported: ${config.supportedReasoningEfforts.join(", ")}. Use /reasoning <effort>.`);
            continue;
          }
          const effort = config.supportedReasoningEfforts.find((value) => value === (selector === "mid" ? "medium" : selector));
          if (!effort) {
            options.io.writeStatus(`Unsupported reasoning effort: ${selector}. Choose: ${config.supportedReasoningEfforts.join(", ")}.`);
            continue;
          }
          if (effort !== currentReasoningEffort && currentConversation) {
            currentConversation = await options.historyStore.setReasoningEffort(currentConversation.id, effort);
          }
          currentReasoningEffort = effort;
          options.io.writeStatus(`Reasoning effort: ${effort}. Applies to subsequent requests in this conversation.`);
        } catch (error) {
          options.io.writeStatus(`Unable to change reasoning effort: ${errorMessage(error)}`);
        }
        continue;
      }
      case "/model": {
        const selector = commandArgument;
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
        currentReasoningEffort = restoreReasoningEffort();
        previousResponseId = undefined;
        options.io.writeStatus(`Switched to model: ${selectedModel}. Started a new conversation.`);
        continue;
      }
      case "/trace":
        if (commandArgument) {
          options.io.writeStatus("Usage: /trace");
          continue;
        }
        if (!options.viewLatestTrace) {
          options.io.writeStatus("Trace viewing is unavailable in this session.");
          continue;
        }
        try {
          const reportPath = await options.viewLatestTrace(currentConversation?.id);
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
      const history = currentConversation ? replayConversation(currentConversation) : undefined;
      if (!currentConversation) {
        currentConversation = await options.historyStore.create({ model: currentModel, title: createConversationTitle(task), reasoningEffort: currentReasoningEffort });
        options.io.writeStatus(`Session log: ${options.historyStore.filePath(currentConversation.id)}`);
      }
      await saveReasoningEffort();
      await options.historyStore.beginTurn(currentConversation.id, task);
      const result = await options.agent.run(task, {
        previousResponseId,
        ...(history?.length ? { history } : {}),
        ...(currentConversation.summary ? { summary: currentConversation.summary } : {}),
        ...(currentConversation.contextUsage ? { contextUsage: currentConversation.contextUsage } : {}),
        model: currentModel,
        ...(currentReasoningEffort ? { reasoningEffort: currentReasoningEffort } : {}),
      });

      previousResponseId = result.responseId;
      options.io.writeAssistant(result.output);

      const turn = {
        user: task,
        assistant: result.output,
        responseId: result.responseId,
        createdAt: new Date().toISOString(),
      };
      try {
        currentConversation = await options.historyStore.appendTurn(currentConversation.id, turn);
      } catch (error) {
        options.io.writeStatus(`Unable to save conversation history: ${errorMessage(error)}`);
      }
    } catch (error) {
      if (currentConversation) {
        try {
          await options.historyStore.failTurn(currentConversation.id, errorMessage(error));
          currentConversation = await options.historyStore.load(currentConversation.id);
          previousResponseId = undefined;
        } catch (saveError) {
          options.io.writeStatus(`Unable to save interrupted conversation: ${errorMessage(saveError)}`);
        }
      }
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
      + `${formatTimestamp(conversation.updatedAt)} (${conversation.turnCount} turn(s), ${conversation.status}, `
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
    ...(conversation.pendingTask ? [`Interrupted task: ${conversation.pendingTask}\nSaved tool results will be included when you continue.`] : []),
  ].join("\n\n");
}

function formatTimestamp(timestamp: string): string {
  return timestamp.replace("T", " ").replace(/:\d{2}\.\d{3}Z$/u, "Z");
}

function uniqueModels(currentModel: string, configuredModels: string[]): string[] {
  const models = [...new Set(configuredModels.map((model) => model.trim()).filter(Boolean))];
  if (!models.includes(currentModel)) models.unshift(currentModel);
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

function formatModelList(models: string[], currentModel: string): string {
  const entries = models.map((model, index) => {
    const marker = model === currentModel ? "*" : " ";
    return `  ${marker} ${index + 1}. ${model}`;
  });
  return [
    `Current model: ${currentModel}`,
    "Available models:",
    ...entries,
    "Use /model <number|name> to switch.",
  ].join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
