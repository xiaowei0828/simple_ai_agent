import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInteractiveSession, type InteractiveAgent, type InteractiveSessionOptions } from "../src/cli/interactive-session.js";
import { AgentResponseError, type AgentRunOptions } from "../src/core/agent-runner.js";
import type { AgentRunResult } from "../src/core/types.js";
import { parseOpenAITraceJsonl } from "../src/trace-viewer/parse-trace.js";
import { JsonlConversationStore } from "../src/history/session-store.js";
import { createTempDirectoryFixture, scriptedIO } from "./test-utils.js";

const createTempDirectory = createTempDirectoryFixture();

async function createStore(): Promise<JsonlConversationStore> {
  const root = await createTempDirectory("simple-code-agent-session-");
  return new JsonlConversationStore(path.join(root, ".agent-runs"));
}

async function runSession(
  options: Omit<InteractiveSessionOptions, "historyStore" | "initialModel">
    & Partial<Pick<InteractiveSessionOptions, "historyStore" | "initialModel">>,
): Promise<void> {
  await runInteractiveSession({
    ...options,
    historyStore: options.historyStore ?? await createStore(),
    initialModel: options.initialModel ?? "test-model",
  });
}

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
    await runSession({
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

    await runSession({
      agent,
      io: scriptedIO(inputs, { assistant: assistantOutputs, status: statusOutputs }),
    });

    expect(agent.calls).toEqual([
      { task: "first question", options: { previousResponseId: undefined, model: "test-model" } },
      { task: "follow up", options: { previousResponseId: "response-1", model: "test-model", history: [
        { role: "user", content: "first question" }, { role: "assistant", content: "answer-1" },
      ] } },
      { task: "fresh question", options: { previousResponseId: undefined, model: "test-model" } },
    ]);
    expect(assistantOutputs).toEqual(["answer-1", "answer-2", "answer-3"]);
    expect(statusOutputs.some((output) => output.includes("Started a new conversation"))).toBe(true);
    expect(statusOutputs.some((output) => output.includes("/help"))).toBe(true);
    expect(statusOutputs.some((output) => output.includes("Unknown command"))).toBe(true);
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

    await runSession({
      agent,
      initialModel: "model-a",
      availableModels: ["model-a", "model-b"],
      io: scriptedIO(inputs, { status: statuses }),
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

  it("changes reasoning without adding turns, passes it to manual compaction, and restores it on resume", async () => {
    const store = await createStore();
    const agent = new FakeInteractiveAgent();
    const compactOptions: AgentRunOptions[] = [];
    const inputs = ["/reasoning", "first", "/reasoning high", "/reasoning max", "/reasoning low extra", "follow up", "/compact", "/exit"];
    const statuses: string[] = [];
    const reasoningConfig: NonNullable<InteractiveSessionOptions["reasoningConfig"]> = () => ({
      reasoningEffort: "medium", supportedReasoningEfforts: ["low", "medium", "high"],
    });
    await runSession({
      agent: { run: (task, options) => agent.run(task, options), async compact(options) { compactOptions.push(options); return undefined; } },
      historyStore: store, reasoningConfig,
      io: scriptedIO(inputs, { status: statuses }),
    });
    expect(agent.calls.map((call) => call.options?.reasoningEffort)).toEqual(["medium", "high"]);
    expect(agent.calls[1]!.options?.previousResponseId).toBe("response-1");
    expect(compactOptions).toHaveLength(1);
    expect(compactOptions[0]!.reasoningEffort).toBe("high");
    expect(statuses.some((text) => text.includes("Supported: low, medium, high"))).toBe(true);
    expect(statuses.filter((text) => text.includes("Unsupported reasoning effort"))).toHaveLength(2);
    const summaries = await store.list();
    expect(summaries).toHaveLength(1);
    const saved = await store.load(summaries[0]!.id);
    expect(saved.reasoningEffort).toBe("high");
    expect(saved.turns).toHaveLength(2);
    const report = parseOpenAITraceJsonl(await readFile(store.filePath(saved.id), "utf8"));
    expect(report.turns).toHaveLength(2);
    expect(report.turns[0]!.rawRequest).toMatchObject({ body: { reasoning: { effort: "medium" } } });
    expect(report.turns[1]!.rawRequest).toMatchObject({ body: { reasoning: { effort: "high" } } });
    const resumed = new FakeInteractiveAgent();
    const resume = [saved.id, "continue", "/reasoning mid", "continue again", "/exit"];
    await runSession({ agent: resumed, historyStore: store, reasoningConfig,
      io: scriptedIO(resume),
    });
    expect(resumed.calls.map((call) => call.options?.reasoningEffort)).toEqual(["high", "medium"]);
    expect(resumed.calls[0]!.options?.previousResponseId).toBeUndefined();
    expect((await store.load(saved.id)).reasoningEffort).toBe("medium");
    expect((await store.load(saved.id)).turns).toHaveLength(4);
  });

  it("uses the model default when a saved effort is no longer allowed", async () => {
    const store = await createStore();
    const saved = await store.create({ model: "test-model", title: "saved", reasoningEffort: "high" });
    const agent = new FakeInteractiveAgent();
    const inputs = ["0", `/resume ${saved.id}`, "continue", "/exit"];
    const statuses: string[] = [];
    await runSession({ agent, historyStore: store,
      reasoningConfig: () => ({ reasoningEffort: "medium", supportedReasoningEfforts: ["medium"] }),
      io: scriptedIO(inputs, { status: statuses }),
    });
    expect(agent.calls[0]!.options?.reasoningEffort).toBe("medium");
    expect(statuses.some((text) => text.includes("using medium"))).toBe(true);
    expect((await store.load(saved.id)).reasoningEffort).toBe("medium");
  });

  it("opens the latest trace report without sending a model request", async () => {
    const agent = new FakeInteractiveAgent();
    const inputs = ["/trace", "/exit"];
    const statuses: string[] = [];
    let traceViews = 0;

    await runSession({
      agent,
      async viewLatestTrace() {
        traceViews += 1;
        return "C:\\workspace\\.agent-runs\\latest.html";
      },
      io: scriptedIO(inputs, { status: statuses }),
    });

    expect(traceViews).toBe(1);
    expect(agent.calls).toEqual([]);
    expect(statuses.some((output) => output.includes("Opened trace report"))).toBe(true);
  });

  it("persists a conversation and resumes it in a later session", async () => {
    const store = await createStore();
    const firstAgent = new FakeInteractiveAgent();
    const firstInputs = ["first question", "/exit"];

    await runSession({
      agent: firstAgent,
      historyStore: store,
      initialModel: "test-model",
      io: scriptedIO(firstInputs),
    });

    const secondAgent = new FakeInteractiveAgent();
    const inputs = ["1", "follow up", "/exit"];
    const statuses: string[] = [];
    await runSession({
      agent: secondAgent,
      historyStore: store,
      initialModel: "another-model",
      availableModels: ["another-model", "test-model"],
      io: scriptedIO(inputs, { status: statuses }),
    });

    expect(secondAgent.calls).toEqual([
      {
        task: "follow up",
        options: {
          previousResponseId: undefined, model: "test-model",
          history: [
            { role: "user", content: "first question" },
            { role: "assistant", content: "answer-1" },
          ],
        },
      },
    ]);
    const conversations = await store.list();
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.turnCount).toBe(2);
    expect(statuses.some((output) => output.includes("Resumed conversation"))).toBe(true);
  });

  it.each(["startup", "command"] as const)("restores through %s without a saved response ID", async (entry) => {
    const store = await createStore();
    const conversation = await store.create({ model: "test-model", title: "Saved discussion" });
    await store.appendTurn(conversation.id, {
      user: "earlier question", assistant: "earlier answer", createdAt: "2026-08-26T01:00:00.000Z",
    });
    const agent = new FakeInteractiveAgent();
    // Switching after a live response must discard that response's continuation ID.
    const prefix = entry === "startup" ? [conversation.id] : ["0", "another task", `/resume ${conversation.id}`];
    const inputs = [...prefix, "follow up", "again", "/exit"];
    await runSession({
      agent, historyStore: store,
      io: scriptedIO(inputs),
    });
    const resumedIndex = entry === "startup" ? 0 : 1;
    expect(agent.calls).toHaveLength(resumedIndex + 2);
    expect(agent.calls[resumedIndex]).toEqual({
      task: "follow up",
      options: {
        previousResponseId: undefined, model: "test-model",
        history: [
          { role: "user", content: "earlier question" },
          { role: "assistant", content: "earlier answer" },
        ],
      },
    });
    expect(agent.calls[resumedIndex + 1]).toEqual({
      task: "again", options: { previousResponseId: `response-${resumedIndex + 1}`, model: "test-model", history: [
        { role: "user", content: "earlier question" }, { role: "assistant", content: "earlier answer" },
        { role: "user", content: "follow up" }, { role: "assistant", content: `answer-${resumedIndex + 1}` },
      ] },
    });
    expect((await store.load(conversation.id)).turns).toHaveLength(3);
  });

  it("records the failed task while preserving completed turns", async () => {
    const store = await createStore();
    const conversation = await store.create({
      model: "test-model",
      title: "Saved discussion",
    });
    await store.appendTurn(conversation.id, {
      user: "earlier question",
      assistant: "earlier answer",
      responseId: "response-old",
      createdAt: "2026-08-26T01:00:00.000Z",
    });
    const inputs = ["1", "failing follow up", "/exit"];

    await runSession({
      agent: {
        async run() {
          throw new Error("temporary failure");
        },
      },
      historyStore: store,
      initialModel: "test-model",
      io: scriptedIO(inputs),
    });

    const persisted = await store.load(conversation.id);
    expect(persisted.turns[0]?.responseId).toBe("response-old");
    expect(persisted.turns).toHaveLength(1);
    expect(persisted.status).toBe("failed");
    expect(persisted.pendingTask).toBe("failing follow up");
    expect(persisted.context.at(-1)).toEqual({ role: "user", content: "failing follow up" });
  });

  it("reuses one failure checkpoint, then falls back to local history", async () => {
    const calls: Array<{ task: string; options?: AgentRunOptions }> = [];
    const inputs = ["first", "failing", "retry", "fallback", "/exit"];
    const agent: InteractiveAgent = {
      async run(task, runOptions) {
        calls.push({ task, options: runOptions });
        if (calls.length === 1) {
          return { output: "answer-1", steps: 1, responseId: "response-1" };
        }
        if (calls.length === 2) {
          throw new AgentResponseError(new Error("offline"), {
            previousResponseId: "response-1",
            pendingInput: "failing",
          });
        }
        if (calls.length === 3) throw new Error("still offline");
        return { output: "answer-4", steps: 1, responseId: "response-4" };
      },
    };

    await runSession({ agent, io: scriptedIO(inputs) });

    expect(calls[2]?.options).toMatchObject({
      previousResponseId: "response-1",
      pendingInput: "failing",
    });
    expect(calls[3]?.options).not.toHaveProperty("pendingInput");
    expect(calls[3]?.options?.previousResponseId).toBeUndefined();
    expect(calls[3]?.options?.history).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "answer-1" },
      { role: "user", content: "failing" },
      { role: "user", content: "retry" },
    ]);
  });

  it("lists and renames the current saved conversation", async () => {
    const store = await createStore();
    const conversation = await store.create({
      model: "test-model",
      title: "Old title",
    });
    await store.appendTurn(conversation.id, {
      user: "question",
      assistant: "answer",
      responseId: "response-old",
      createdAt: "2026-08-26T01:00:00.000Z",
    });
    const inputs = ["1", "/rename New title", "/history", "/exit"];
    const statuses: string[] = [];

    await runSession({
      agent: new FakeInteractiveAgent(),
      historyStore: store,
      initialModel: "test-model",
      io: scriptedIO(inputs, { status: statuses }),
    });

    expect((await store.load(conversation.id)).title).toBe("New title");
    expect(statuses.some((output) => output.includes("Renamed conversation"))).toBe(true);
    expect(statuses.some((output) => output.includes("New title"))).toBe(true);
  });
});
