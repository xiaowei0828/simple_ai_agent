import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, readFile, readdir, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { REASONING_EFFORTS, type AgentEvent, type ContextUsage, type ModelInputItem, type ModelResponse, type ReasoningEffort } from "../core/types.js";
import { responseContextUsage, responseInputItems } from "../core/context-compaction.js";
import type { OpenAITraceEntry, OpenAITraceSink } from "../logging/openai-trace.js";

const turnSchema = z.object({
  user: z.string(), assistant: z.string(), responseId: z.string().min(1).optional(), createdAt: z.string(),
});
export type ConversationTurn = z.infer<typeof turnSchema>;
export interface Conversation {
  schemaVersion: 2;
  id: string;
  title: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
  createdAt: string;
  updatedAt: string;
  turns: ConversationTurn[];
  context: ModelInputItem[];
  summary?: string;
  contextUsage?: ContextUsage;
  status: "idle" | "running" | "failed";
  pendingTask?: string;
}
export interface ConversationSummary {
  id: string; title: string; model: string; createdAt: string; updatedAt: string; turnCount: number;
  status: Conversation["status"];
}
export interface CreateConversationInput {
  model: string; title: string; reasoningEffort?: ReasoningEffort;
}
export interface ConversationStore {
  list(): Promise<ConversationSummary[]>;
  load(id: string): Promise<Conversation>;
  create(input: CreateConversationInput): Promise<Conversation>;
  appendTurn(id: string, turn: ConversationTurn): Promise<Conversation>;
  rename(id: string, title: string): Promise<Conversation>;
  setReasoningEffort(id: string, effort: ReasoningEffort): Promise<Conversation>;
  beginTurn(id: string, task: string): Promise<void>;
  failTurn(id: string, error: string): Promise<void>;
  filePath(id: string): string;
  beginCompaction(id: string): void;
  endCompaction(): void;
}
interface StoreOptions {
  onWarning?: (message: string) => void;
}
export interface SessionEntry {
  type: string;
  timestamp: string;
  turnId?: string;
  step?: number;
  [key: string]: unknown;
}
const headerSchema = z.object({
  type: z.literal("session.created"), schemaVersion: z.literal(2),
  id: z.string().uuid(), title: z.string().trim().min(1), model: z.string().min(1), timestamp: z.string(),
  reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
});

/** One append-only file is the source for both resume and the trace viewer. */
export class JsonlConversationStore implements ConversationStore, OpenAITraceSink {
  readonly #directory: string;
  readonly #options: StoreOptions;
  readonly #queues = new Map<string, Promise<void>>();
  readonly #ready = new Set<string>();
  #active?: { id: string; turnId: string; step: number };

  constructor(directory: string, options: StoreOptions = {}) {
    this.#directory = path.resolve(directory);
    this.#options = options;
  }

  filePath(id: string): string {
    return path.join(this.#directory, `${z.string().uuid().parse(id)}.jsonl`);
  }

  async list(): Promise<ConversationSummary[]> {
    let files: string[];
    try { files = await readdir(this.#directory); }
    catch (error) { if (hasCode(error, "ENOENT")) return []; throw error; }
    const conversations: ConversationSummary[] = [];
    for (const file of files.filter((name) => name.endsWith(".jsonl"))) {
      const id = file.slice(0, -6);
      if (!z.string().uuid().safeParse(id).success) continue;
      try { conversations.push(await this.#loadSummary(id)); }
      catch (error) { this.#options.onWarning?.(`Skipping invalid conversation '${file}': ${String(error)}`); }
    }
    return conversations.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async #loadSummary(id: string): Promise<ConversationSummary> {
    await this.#queues.get(id);
    let summary: ConversationSummary | undefined;
    for await (const entry of readSessionEntries(this.filePath(id))) {
      if (!summary) {
        const header = headerSchema.parse(entry);
        if (header.id !== id) throw new Error("Session ID does not match its filename.");
        summary = {
          id, title: header.title, model: header.model, createdAt: header.timestamp,
          updatedAt: header.timestamp, turnCount: 0, status: "idle",
        };
        continue;
      }
      if (entry.type.startsWith("session.")) summary.updatedAt = entry.timestamp;
      switch (entry.type) {
        case "session.renamed": summary.title = z.string().min(1).parse(entry.title); break;
        case "session.turn_started": summary.status = "running"; break;
        case "session.turn_failed": summary.status = "failed"; break;
        case "session.turn_completed":
          turnSchema.parse(entry.turn);
          summary.turnCount++;
          summary.status = "idle";
          break;
      }
    }
    if (!summary) throw new Error("Session header is missing.");
    return summary;
  }

  async load(id: string): Promise<Conversation> {
    await this.#queues.get(id);
    const entries = parseSessionEntries(await readFile(this.filePath(id), "utf8"));
    const header = headerSchema.parse(entries[0]);
    if (header.id !== id) throw new Error("Session ID does not match its filename.");
    const conversation: Conversation = {
      schemaVersion: 2, id, title: header.title, model: header.model,
      ...(header.reasoningEffort ? { reasoningEffort: header.reasoningEffort } : {}),
      createdAt: header.timestamp, updatedAt: header.timestamp, turns: [], context: [], status: "idle",
    };
    let hasResponse = false;
    let hasUser = false;
    for (const entry of entries.slice(1)) {
      if (entry.type.startsWith("session.")) conversation.updatedAt = entry.timestamp;
      switch (entry.type) {
        case "session.reasoning_effort_changed":
          conversation.reasoningEffort = z.enum(REASONING_EFFORTS).parse(entry.reasoningEffort);
          break;
        case "session.renamed": conversation.title = z.string().min(1).parse(entry.title); break;
        case "session.turn_started":
          conversation.pendingTask = z.string().parse(entry.task);
          conversation.context.push({ role: "user", content: conversation.pendingTask });
          conversation.status = "running";
          hasResponse = false; hasUser = true;
          break;
        case "session.model_response":
          conversation.context.push(...responseInputItems(entry.response as ModelResponse));
          conversation.contextUsage = responseContextUsage(entry.response as ModelResponse, conversation.context.length)
            ?? conversation.contextUsage;
          hasResponse = true;
          break;
        case "session.compacted":
          conversation.summary = z.string().trim().min(1).parse(entry.summary);
          conversation.context = z.array(z.record(z.string(), z.unknown())).parse(entry.replacementHistory) as ModelInputItem[];
          conversation.contextUsage = undefined;
          break;
        case "session.tool_output": conversation.context.push(entry.output as ModelInputItem); break;
        case "session.turn_completed": {
          const turn = turnSchema.parse(entry.turn);
          // Embedders without runner events still have a transcript.
          if (!hasUser) conversation.context.push({ role: "user", content: turn.user });
          if (!hasResponse) conversation.context.push({ role: "assistant", content: turn.assistant });
          conversation.turns.push(turn);
          conversation.status = "idle";
          conversation.pendingTask = undefined;
          hasResponse = false; hasUser = false;
          break;
        }
        case "session.turn_failed": conversation.status = "failed"; break;
      }
    }
    return conversation;
  }

  async create(input: CreateConversationInput): Promise<Conversation> {
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const header = headerSchema.parse({ type: "session.created", schemaVersion: 2, id, timestamp, model: input.model, title: input.title, reasoningEffort: input.reasoningEffort });
    await mkdir(this.#directory, { recursive: true });
    await writeFile(this.filePath(id), JSON.stringify(header) + "\n", { flag: "wx", mode: 0o600 });
    this.#ready.add(id);
    return this.load(id);
  }

  async beginTurn(id: string, task: string): Promise<void> {
    this.#active = { id, turnId: randomUUID(), step: 0 };
    await this.#append(id, { type: "session.turn_started", timestamp: new Date().toISOString(), turnId: this.#active.turnId, task });
  }

  /** Manual compaction uses the same journal without adding a user turn. */
  beginCompaction(id: string): void {
    this.filePath(id);
    this.#active = { id, turnId: randomUUID(), step: 0 };
  }

  endCompaction(): void {
    this.#active = undefined;
  }

  async appendTurn(id: string, turn: ConversationTurn): Promise<Conversation> {
    await this.#append(id, { type: "session.turn_completed", timestamp: new Date().toISOString(), turnId: this.#active?.turnId, turn: turnSchema.parse(turn) });
    this.#active = undefined;
    return this.load(id);
  }

  async failTurn(id: string, error: string): Promise<void> {
    await this.#append(id, { type: "session.turn_failed", timestamp: new Date().toISOString(), turnId: this.#active?.turnId, step: this.#active?.step, error });
    this.#active = undefined;
  }

  async rename(id: string, title: string): Promise<Conversation> {
    await this.#append(id, { type: "session.renamed", timestamp: new Date().toISOString(), title: z.string().trim().min(1).parse(title) });
    return this.load(id);
  }

  async setReasoningEffort(id: string, effort: ReasoningEffort): Promise<Conversation> {
    await this.#append(id, {
      type: "session.reasoning_effort_changed", timestamp: new Date().toISOString(),
      reasoningEffort: z.enum(REASONING_EFFORTS).parse(effort),
    });
    return this.load(id);
  }

  async recordAgentEvent(event: AgentEvent): Promise<void> {
    const active = this.#active;
    if (!active) return;
    if (event.type === "model_requested" || event.type === "compaction_started") active.step = event.step;
    if (!["model_requested", "model_response", "tool_output", "compaction_started", "compaction_completed", "compaction_failed"].includes(event.type)) return;
    const saved = event.type === "compaction_completed"
      ? { ...event.result, type: "session.compacted", step: event.step }
      : { ...event, type: `session.${event.type}` };
    await this.#append(active.id, { ...saved, timestamp: new Date().toISOString(), turnId: active.turnId });
  }

  /** Debug entries share the session file and the same request coordinates. */
  async log(entry: OpenAITraceEntry): Promise<void> {
    if (!this.#active) return;
    await this.#append(this.#active.id, { ...entry, turnId: this.#active.turnId, step: this.#active.step });
  }

  async #append(id: string, entry: SessionEntry): Promise<void> {
    const previous = this.#queues.get(id) ?? Promise.resolve();
    const next = previous.then(async () => {
      const file = this.filePath(id);
      if (!this.#ready.has(id)) {
        const data = await readFile(file);
        // A killed process may leave a partial final line. Repair only the tail.
        if (data.length && data[data.length - 1] !== 10) {
          const boundary = data.lastIndexOf(10) + 1;
          try { JSON.parse(data.subarray(boundary).toString("utf8")); await appendFile(file, "\n"); }
          catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            await truncate(file, boundary);
            this.#options.onWarning?.(`Discarded an incomplete final journal line in ${file}.`);
          }
        }
        this.#ready.add(id);
      }
      await appendFile(file, JSON.stringify(entry) + "\n", "utf8");
    });
    this.#queues.set(id, next);
    await next;
  }
}

export function parseSessionEntries(contents: string): SessionEntry[] {
  const lines = contents.split("\n");
  const entries: SessionEntry[] = [];
  for (const [index, line] of lines.entries()) {
    const entry = parseSessionLine(line, index + 1, index === lines.length - 1);
    if (entry) entries.push(entry);
  }
  return entries;
}

function parseSessionLine(line: string, lineNumber: number, partialTail: boolean): SessionEntry | undefined {
  if (!line.trim()) return undefined;
  try {
    const entry = JSON.parse(line) as SessionEntry;
    if (!entry || typeof entry.type !== "string") throw new Error(`Invalid journal entry at line ${lineNumber}.`);
    return entry;
  } catch (error) {
    if (partialTail && error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/** Keep at most a buffered chunk and the current entry, never the entire debug journal. */
async function* readSessionEntries(file: string): AsyncGenerator<SessionEntry> {
  const stream = createReadStream(file, { encoding: "utf8" });
  let pending = "";
  let lineNumber = 0;
  for await (const chunk of stream) {
    pending += chunk;
    let boundary: number;
    while ((boundary = pending.indexOf("\n")) !== -1) {
      const entry = parseSessionLine(pending.slice(0, boundary), ++lineNumber, false);
      pending = pending.slice(boundary + 1);
      if (entry) yield entry;
    }
  }
  const tail = parseSessionLine(pending, lineNumber + 1, true);
  if (tail) yield tail;
}

/** Unknown execution outcomes become context, never automatic tool re-execution. */
export function replayConversation(conversation: Conversation): ModelInputItem[] {
  const result: ModelInputItem[] = [];
  const pending = new Set<string>();
  const finishPending = () => {
    for (const id of pending) result.push({ type: "function_call_output", call_id: id, output: JSON.stringify({ ok: false, error: "The agent stopped before saving this tool's result. Its execution outcome is unknown; inspect current state before repeating it." }) });
    pending.clear();
  };
  for (const item of conversation.context) {
    if ("role" in item && item.role === "user") finishPending();
    if ("type" in item && item.type === "function_call" && typeof item.call_id === "string") pending.add(item.call_id);
    if ("type" in item && item.type === "function_call_output" && typeof item.call_id === "string") pending.delete(item.call_id);
    result.push(item);
  }
  finishPending();
  return result;
}

export function createConversationTitle(message: string, maxLength = 60): string {
  const title = message.replace(/\s+/gu, " ").trim();
  return title.length <= maxLength ? title : `${title.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}
function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
