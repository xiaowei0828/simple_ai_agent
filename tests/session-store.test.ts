import { appendFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createConversationTitle,
  JsonlConversationStore,
} from "../src/history/session-store.js";
import { createTempDirectoryFixture } from "./test-utils.js";

const createTempDirectory = createTempDirectoryFixture();

async function fixtureDirectory(): Promise<string> {
  const root = await createTempDirectory("simple-code-agent-history-");
  return path.join(root, ".agent-runs");
}

describe("JsonlConversationStore", () => {
  it("lists metadata from a large debug journal without loading conversation context", async () => {
    const store = new JsonlConversationStore(await fixtureDirectory());
    const session = await store.create({ model: "test", title: "initial" });
    const timestamp = "2030-01-01T00:00:00.000Z";
    const entries = [
      { type: "session.turn_started", task: "question" },
      { type: "session.model_response", response: { id: "answer", outputText: "中文".repeat(40_000), toolCalls: [] } },
      ...Array.from({ length: 200 }, () => ({ type: "openai.stream", event: { delta: "debug".repeat(500) } })),
      { type: "session.turn_completed", turn: { user: "question", assistant: "answer", createdAt: timestamp } },
      { type: "session.renamed", title: "updated" },
      { type: "session.turn_started", task: "follow up" },
      { type: "session.turn_failed", error: "interrupted" },
      { type: "openai.error", timestamp: "2031-01-01T00:00:00.000Z" },
    ];
    await appendFile(store.filePath(session.id), entries.map((entry) => JSON.stringify({ timestamp, ...entry })).join("\n") + "\n");
    const loaded = await store.load(session.id);
    const load = vi.spyOn(store, "load").mockRejectedValue(new Error("list must not rebuild context"));
    expect(await store.list()).toEqual([{
      id: loaded.id, title: loaded.title, model: loaded.model, createdAt: loaded.createdAt,
      updatedAt: loaded.updatedAt, turnCount: loaded.turns.length, status: loaded.status,
    }]);
    expect(load).not.toHaveBeenCalled();
    load.mockRestore();
    await store.beginTurn(session.id, "retry");
    expect((await store.list())[0]?.status).toBe("running");
  });

  it.each([
    { tail: '{"type":"session.turn_failed"', valid: true },
    { tail: '{"type":"session.turn_failed", "timestamp":"2030-01-01"}', valid: true },
    { tail: '{broken}\n', valid: false },
  ])("handles journal tails consistently: $tail", async ({ tail, valid }) => {
    const warnings: string[] = [];
    const store = new JsonlConversationStore(await fixtureDirectory(), { onWarning: (message) => warnings.push(message) });
    const session = await store.create({ model: "test", title: "tail" });
    await appendFile(store.filePath(session.id), tail);
    expect(await store.list()).toHaveLength(valid ? 1 : 0);
    expect(warnings).toHaveLength(valid ? 0 : 1);
    if (valid) expect((await store.list())[0]?.status).toBe((await store.load(session.id)).status);
    else await expect(store.load(session.id)).rejects.toThrow();
  });

  it("creates, updates, renames, and lists conversations", async () => {
    const historyDirectory = await fixtureDirectory();
    const store = new JsonlConversationStore(historyDirectory);
    const firstTurn = {
      user: "first question",
      assistant: "first answer",
      responseId: "response-1",
      createdAt: "2026-08-26T01:00:00.000Z",
    };

    const created = await store.create({
      model: "test-model",
      title: "First question",
    });
    await store.appendTurn(created.id, firstTurn);
    const appended = await store.appendTurn(created.id, {
      user: "follow up",
      assistant: "second answer",
      responseId: "response-2",
      createdAt: "2026-08-26T01:01:00.000Z",
    });
    const renamed = await store.rename(created.id, "Useful discussion");

    expect(appended.turns.at(-1)?.responseId).toBe("response-2");
    expect(appended.turns).toHaveLength(2);
    expect(renamed.title).toBe("Useful discussion");
    expect(await store.load(created.id)).toMatchObject({
      title: "Useful discussion",
      turns: [firstTurn, { responseId: "response-2" }],
    });
    expect(await store.list()).toEqual([
      expect.objectContaining({
        id: created.id,
        title: "Useful discussion",
        model: "test-model",
        turnCount: 2,
      }),
    ]);
    if (process.platform !== "win32") {
      expect((await stat(path.join(historyDirectory, `${created.id}.jsonl`))).mode & 0o777)
        .toBe(0o600);
    }
  });

  it("skips invalid history files while listing", async () => {
    const historyDirectory = await fixtureDirectory();
    const warnings: string[] = [];
    const store = new JsonlConversationStore(historyDirectory, {
      onWarning(message) {
        warnings.push(message);
      },
    });
    await store.create({
      model: "test-model",
      title: "Valid",
    });
    await writeFile(path.join(historyDirectory, "00000000-0000-4000-8000-000000000000.jsonl"), "{", "utf8");

    expect(await store.list()).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("00000000-0000-4000-8000-000000000000.jsonl");
  });

  it("builds a compact title from the first user message", () => {
    expect(createConversationTitle("  inspect\n\n  the   project  ")).toBe("inspect the project");
    expect(createConversationTitle("123456789", 6)).toBe("12345…");
  });
});
