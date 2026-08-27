import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const conversationTurnSchema = z.object({
  user: z.string(),
  assistant: z.string(),
  responseId: z.string().trim().min(1),
  createdAt: z.string().datetime(),
}).strict();

const conversationSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().uuid(),
  title: z.string().trim().min(1),
  model: z.string().trim().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastResponseId: z.string().trim().min(1).optional(),
  turns: z.array(conversationTurnSchema).min(1),
}).strict();

export type ConversationTurn = z.infer<typeof conversationTurnSchema>;
export type Conversation = z.infer<typeof conversationSchema>;

export interface ConversationSummary {
  id: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
}

export interface CreateConversationInput {
  model: string;
  title: string;
  firstTurn: ConversationTurn;
}

export interface ConversationStore {
  list(): Promise<ConversationSummary[]>;
  load(id: string): Promise<Conversation>;
  create(input: CreateConversationInput): Promise<Conversation>;
  appendTurn(id: string, turn: ConversationTurn): Promise<Conversation>;
  rename(id: string, title: string): Promise<Conversation>;
}

export interface JsonConversationStoreOptions {
  onWarning?: (message: string) => void;
}

export class JsonConversationStore implements ConversationStore {
  readonly #directory: string;
  readonly #onWarning?: (message: string) => void;

  constructor(directory: string, options: JsonConversationStoreOptions = {}) {
    this.#directory = path.resolve(directory);
    this.#onWarning = options.onWarning;
  }

  async list(): Promise<ConversationSummary[]> {
    let entries;
    try {
      entries = await readdir(this.#directory, { withFileTypes: true });
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) return [];
      throw new Error(`Unable to list conversation history: ${errorMessage(error)}`);
    }

    const conversations = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry): Promise<Conversation | undefined> => {
        try {
          return await this.#loadFile(path.join(this.#directory, entry.name));
        } catch (error) {
          this.#onWarning?.(`Skipping invalid conversation '${entry.name}': ${errorMessage(error)}`);
          return undefined;
        }
      }));

    return conversations
      .filter((conversation): conversation is Conversation => conversation !== undefined)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        model: conversation.model,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        turnCount: conversation.turns.length,
      }));
  }

  async load(id: string): Promise<Conversation> {
    return this.#loadFile(this.#conversationPath(id));
  }

  async create(input: CreateConversationInput): Promise<Conversation> {
    const now = new Date().toISOString();
    const conversation = conversationSchema.parse({
      schemaVersion: 1,
      id: randomUUID(),
      title: input.title,
      model: input.model,
      createdAt: now,
      updatedAt: now,
      lastResponseId: input.firstTurn.responseId,
      turns: [input.firstTurn],
    });
    await this.#save(conversation, true);
    return conversation;
  }

  async appendTurn(id: string, turn: ConversationTurn): Promise<Conversation> {
    const conversation = await this.load(id);
    const updated = conversationSchema.parse({
      ...conversation,
      updatedAt: new Date().toISOString(),
      lastResponseId: turn.responseId,
      turns: [...conversation.turns, turn],
    });
    await this.#save(updated, false);
    return updated;
  }

  async rename(id: string, title: string): Promise<Conversation> {
    const conversation = await this.load(id);
    const updated = conversationSchema.parse({
      ...conversation,
      title,
      updatedAt: new Date().toISOString(),
    });
    await this.#save(updated, false);
    return updated;
  }

  async #loadFile(filePath: string): Promise<Conversation> {
    let contents: string;
    try {
      contents = await readFile(filePath, "utf8");
    } catch (error) {
      throw new Error(`Unable to read conversation '${filePath}': ${errorMessage(error)}`);
    }

    let value: unknown;
    try {
      value = JSON.parse(contents);
    } catch (error) {
      throw new Error(`Invalid JSON in conversation '${filePath}': ${errorMessage(error)}`);
    }

    const parsed = conversationSchema.safeParse(value);
    if (!parsed.success) {
      const details = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "conversation"}: ${issue.message}`)
        .join("; ");
      throw new Error(`Invalid conversation '${filePath}': ${details}`);
    }
    return parsed.data;
  }

  async #save(conversation: Conversation, exclusive: boolean): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const destination = this.#conversationPath(conversation.id);
    const temporary = path.join(
      this.#directory,
      `.${conversation.id}.${process.pid}.${randomUUID()}.tmp`,
    );

    try {
      await writeFile(temporary, `${JSON.stringify(conversation, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      if (exclusive) {
        try {
          await readFile(destination, "utf8");
          throw new Error(`Conversation '${conversation.id}' already exists.`);
        } catch (error) {
          if (!isFileSystemError(error, "ENOENT")) throw error;
        }
      }
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  #conversationPath(id: string): string {
    const parsedId = z.string().uuid().safeParse(id);
    if (!parsedId.success) throw new Error(`Invalid conversation ID: ${id}`);
    return path.join(this.#directory, `${parsedId.data}.json`);
  }
}

export function createConversationTitle(message: string, maxLength = 60): string {
  const normalized = message.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function isFileSystemError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
