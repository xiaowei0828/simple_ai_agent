import { mkdir, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { OpenAITraceEntry, OpenAITraceSink } from "./openai-trace.js";

export class JsonlTraceLogger implements OpenAITraceSink {
  readonly filePath: string;
  readonly #file: FileHandle;
  #writeQueue: Promise<void> = Promise.resolve();

  private constructor(filePath: string, file: FileHandle) {
    this.filePath = filePath;
    this.#file = file;
  }

  static async create(directory: string): Promise<JsonlTraceLogger> {
    await mkdir(directory, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = path.join(directory, `${timestamp}-${process.pid}.jsonl`);
    const file = await open(filePath, "wx", 0o600);
    return new JsonlTraceLogger(filePath, file);
  }

  async log(entry: OpenAITraceEntry): Promise<void> {
    const line = `${JSON.stringify(entry)}\n`;
    this.#writeQueue = this.#writeQueue.then(async () => {
      await this.#file.appendFile(line, "utf8");
    });
    await this.#writeQueue;
  }

  async close(): Promise<void> {
    await this.flush();
    await this.#file.close();
  }

  async flush(): Promise<void> {
    await this.#writeQueue;
  }
}
