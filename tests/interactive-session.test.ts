import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInteractiveSession, type InteractiveAgent } from "../src/cli/interactive-session.js";
import type { AgentRunOptions } from "../src/core/agent-runner.js";
import { PreviousResponseUnavailableError } from "../src/core/errors.js";
import type { AgentRunResult } from "../src/core/types.js";
import { JsonConversationStore } from "../src/history/conversation-store.js";

class FakeInteractiveAgent implements InteractiveAgent {
  readonly calls: Array<{ task: string; options?: AgentRunOptions }> = [];

  async run(task: string, options?: AgentRunOptions): Promise<AgentRunResult> {
    this.calls.push({ task, options });
    const turn = this.calls.length;
    return {
      output: `answer-${turn}`,
      steps: 1,
      responseId: `response-${turn}`,
    };
  }
}

describe("runInteractiveSession", () => {
  it("waits for interactive input and exits at EOF without requesting the model", async () => {
    const agent = new FakeInteractiveAgent();
    const prompts: string[] = [];
    await runInteractiveSession({
      agent,
      io: {
        async prompt(label) {
          expect(agent.calls).toEqual([]);
          prompts.push(label);
          return undefined;
        },
        writeAssistant() {},
        writeStatus() {},
      },
    });
    expect(prompts).toEqual(["agent> "]);
    expect(agent.calls).toEqual([]);
  });

  it("chains successful turns and resets context with /new", async () => {
    const agent = new FakeInteractiveAgent();
    const inputs = ["first question", "follow up", "/new", "fresh question", "/help", "/unknown", "/exit"];
    const assistantOutputs: string[] = [];
    const statusOutputs: string[] = [];

    await runInteractiveSession({
      agent,
      io: {
        async prompt() {
          return inputs.shift();
        },
        writeAssistant(output) {
          assistantOutputs.push(output);
        },
        writeStatus(output) {
          statusOutputs.push(output);
        },
      },
    });

    expect(agent.calls).toEqual([
      { task: "first question", options: { previousResponseId: undefined } },
      { task: "follow up", options: { previousResponseId: "response-1" } },
      { task: "fresh question", options: { previousResponseId: undefined } },
    ]);
    expect(assistantOutputs).toEqual(["answer-1", "answer-2", "answer-3"]);
    expect(statusOutputs.some((output) => output.includes("Started a new conversation"))).toBe(true);
    expect(statusOutputs.some((output) => output.includes("/help"))).toBe(true);
    expect(statusOutputs.some((output) => output.includes("Unknown command"))).toBe(true);
  });

  it("keeps the last successful conversation after a failed turn", async () => {
    let call = 0;
    const previousIds: Array<string | undefined> = [];
    const agent: InteractiveAgent = {
      async run(_task, options) {
        call += 1;
        previousIds.push(options?.previousResponseId);
        if (call === 2) throw new Error("temporary failure");
        return { output: "ok", steps: 1, responseId: `response-${call}` };
      },
    };
    const inputs = ["first", "fails", "retry", "/exit"];
    const statuses: string[] = [];

    await runInteractiveSession({
      agent,
      io: {
        async prompt() {
          return inputs.shift();
        },
        writeAssistant() {},
        writeStatus(output) {
          statuses.push(output);
        },
      },
    });

    expect(previousIds).toEqual([undefined, "response-1", "response-1"]);
    expect(statuses.some((output) => output.includes("temporary failure"))).toBe(true);
  });

  it("lists configured models and switches by number or name", async () => {
    const agent = new FakeInteractiveAgent();
    const inputs = [
      "first",
      "/model",
      "/model 2",
      "second",
      "/model model-a",
      "third",
      "/model missing",
      "/exit",
    ];
    const statuses: string[] = [];

    await runInteractiveSession({
      agent,
      initialModel: "model-a",
      availableModels: ["model-a", "model-b"],
      io: {
        async prompt() {
          return inputs.shift();
        },
        writeAssistant() {},
        writeStatus(output) {
          statuses.push(output);
        },
      },
    });

    expect(agent.calls).toEqual([
      { task: "first", options: { previousResponseId: undefined, model: "model-a" } },
      { task: "second", options: { previousResponseId: undefined, model: "model-b" } },
      { task: "third", options: { previousResponseId: undefined, model: "model-a" } },
    ]);
    expect(statuses.some((output) => output.includes("* 1. model-a"))).toBe(true);
    expect(statuses.some((output) => output.includes("Switched to model: model-b"))).toBe(true);
    expect(statuses.some((output) => output.includes("Unknown model: missing"))).toBe(true);
  });

  it("opens the latest trace report without sending a model request", async () => {
    const agent = new FakeInteractiveAgent();
    const inputs = ["/trace", "/exit"];
    const statuses: string[] = [];
    let traceViews = 0;

    await runInteractiveSession({
      agent,
      async viewLatestTrace() {
        traceViews += 1;
        return "C:\\workspace\\.agent-runs\\latest.html";
      },
      io: {
        async prompt() {
          return inputs.shift();
        },
        writeAssistant() {},
        writeStatus(output) {
          statuses.push(output);
        },
      },
    });

    expect(traceViews).toBe(1);
    expect(agent.calls).toEqual([]);
    expect(statuses.some((output) => output.includes("Opened trace report"))).toBe(true);
  });

  it("persists a conversation and resumes it in a later session", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-session-"));
    const store = new JsonConversationStore(path.join(root, ".agent-history"));
    const firstAgent = new FakeInteractiveAgent();
    const firstInputs = ["first question", "/exit"];

    await runInteractiveSession({
      agent: firstAgent,
      historyStore: store,
      initialModel: "test-model",
      io: {
        async prompt() {
          return firstInputs.shift();
        },
        writeAssistant() {},
        writeStatus() {},
      },
    });

    const secondAgent = new FakeInteractiveAgent();
    const inputs = ["1", "follow up", "/exit"];
    const statuses: string[] = [];
    await runInteractiveSession({
      agent: secondAgent,
      historyStore: store,
      initialModel: "another-model",
      availableModels: ["another-model", "test-model"],
      io: {
        async prompt() {
          return inputs.shift();
        },
        writeAssistant() {},
        writeStatus(output) {
          statuses.push(output);
        },
      },
    });

    expect(secondAgent.calls).toEqual([
      {
        task: "follow up",
        options: { previousResponseId: "response-1", model: "test-model" },
      },
    ]);
    const conversations = await store.list();
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.turnCount).toBe(2);
    expect(statuses.some((output) => output.includes("Resumed conversation"))).toBe(true);
  });

  it("replays the local transcript when the remote response is unavailable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-session-"));
    const store = new JsonConversationStore(path.join(root, ".agent-history"));
    const conversation = await store.create({
      model: "test-model",
      title: "Saved discussion",
      firstTurn: {
        user: "earlier question",
        assistant: "earlier answer",
        responseId: "response-old",
        createdAt: "2026-08-26T01:00:00.000Z",
      },
    });
    const calls: Array<{ task: string; options?: AgentRunOptions }> = [];
    const agent: InteractiveAgent = {
      async run(task, options) {
        calls.push({ task, options });
        if (options?.previousResponseId) {
          throw new PreviousResponseUnavailableError(options.previousResponseId);
        }
        return { output: "recovered answer", steps: 1, responseId: "response-new" };
      },
    };
    const inputs = [conversation.id.slice(0, 8), "follow up", "/exit"];
    const statuses: string[] = [];

    await runInteractiveSession({
      agent,
      historyStore: store,
      initialModel: "test-model",
      io: {
        async prompt() {
          return inputs.shift();
        },
        writeAssistant() {},
        writeStatus(output) {
          statuses.push(output);
        },
      },
    });

    expect(calls).toEqual([
      {
        task: "follow up",
        options: { previousResponseId: "response-old", model: "test-model" },
      },
      {
        task: "follow up",
        options: {
          history: [
            { role: "user", content: "earlier question" },
            { role: "assistant", content: "earlier answer" },
          ],
          model: "test-model",
        },
      },
    ]);
    expect((await store.load(conversation.id)).lastResponseId).toBe("response-new");
    expect(statuses.some((output) => output.includes("Replaying"))).toBe(true);
  });

  it("does not advance persisted history after a failed turn", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-session-"));
    const store = new JsonConversationStore(path.join(root, ".agent-history"));
    const conversation = await store.create({
      model: "test-model",
      title: "Saved discussion",
      firstTurn: {
        user: "earlier question",
        assistant: "earlier answer",
        responseId: "response-old",
        createdAt: "2026-08-26T01:00:00.000Z",
      },
    });
    const inputs = ["1", "failing follow up", "/exit"];

    await runInteractiveSession({
      agent: {
        async run() {
          throw new Error("temporary failure");
        },
      },
      historyStore: store,
      initialModel: "test-model",
      io: {
        async prompt() {
          return inputs.shift();
        },
        writeAssistant() {},
        writeStatus() {},
      },
    });

    const persisted = await store.load(conversation.id);
    expect(persisted.lastResponseId).toBe("response-old");
    expect(persisted.turns).toHaveLength(1);
  });

  it("lists and renames the current saved conversation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-session-"));
    const store = new JsonConversationStore(path.join(root, ".agent-history"));
    const conversation = await store.create({
      model: "test-model",
      title: "Old title",
      firstTurn: {
        user: "question",
        assistant: "answer",
        responseId: "response-old",
        createdAt: "2026-08-26T01:00:00.000Z",
      },
    });
    const inputs = ["1", "/rename New title", "/history", "/exit"];
    const statuses: string[] = [];

    await runInteractiveSession({
      agent: new FakeInteractiveAgent(),
      historyStore: store,
      initialModel: "test-model",
      io: {
        async prompt() {
          return inputs.shift();
        },
        writeAssistant() {},
        writeStatus(output) {
          statuses.push(output);
        },
      },
    });

    expect((await store.load(conversation.id)).title).toBe("New title");
    expect(statuses.some((output) => output.includes("Renamed conversation"))).toBe(true);
    expect(statuses.some((output) => output.includes("New title"))).toBe(true);
  });
});
