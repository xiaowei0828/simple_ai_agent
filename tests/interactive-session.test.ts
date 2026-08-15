import { describe, expect, it } from "vitest";
import { runInteractiveSession, type InteractiveAgent } from "../src/cli/interactive-session.js";
import type { AgentRunOptions } from "../src/core/agent-runner.js";
import type { AgentRunResult } from "../src/core/types.js";

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
  it("chains successful turns and resets context with /new", async () => {
    const agent = new FakeInteractiveAgent();
    const inputs = ["follow up", "/new", "fresh question", "/help", "/unknown", "/exit"];
    const assistantOutputs: string[] = [];
    const statusOutputs: string[] = [];

    await runInteractiveSession({
      agent,
      initialTask: "first question",
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
});
