import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createConversationTitle,
  JsonlConversationStore,
} from "../src/history/session-store.js";

describe("JsonlConversationStore", () => {
  it("creates, updates, renames, and lists conversations", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-history-"));
    const historyDirectory = path.join(root, ".agent-runs");
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
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-history-"));
    const historyDirectory = path.join(root, ".agent-runs");
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
