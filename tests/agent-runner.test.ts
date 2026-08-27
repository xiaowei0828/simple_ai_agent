import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentLimitError, AgentRunner } from "../src/core/agent-runner.js";
import type {
  AgentEvent,
  ModelAdapter,
  ModelRequest,
  ModelResponse,
} from "../src/core/types.js";
import { AllowAllApprovalPolicy, DenyAllApprovalPolicy } from "../src/policy/approval-policy.js";
import { createDefaultToolRegistry } from "../src/tools/index.js";

class ScriptedModel implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  readonly #responses: ModelResponse[];

  constructor(responses: ModelResponse[]) {
    this.#responses = [...responses];
  }

  async respond(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const response = this.#responses.shift();
    if (!response) throw new Error("No scripted response remains.");
    return response;
  }
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-"));
  await writeFile(path.join(root, "hello.ts"), "export const answer = 42;\n", "utf8");
  return root;
}

describe("AgentRunner", () => {
  it("allows one run to override the configured model", async () => {
    const root = await fixture();
    const model = new ScriptedModel([
      { id: "response-override", outputText: "Done.", toolCalls: [] },
    ]);
    const runner = new AgentRunner({
      model,
      modelName: "default-model",
      instructions: "test instructions",
      tools: createDefaultToolRegistry([]),
      toolContext: { workspaceRoot: root },
      approvalPolicy: new DenyAllApprovalPolicy(),
    });

    await runner.run("use another model", { model: "selected-model" });

    expect(model.requests[0]?.model).toBe("selected-model");
  });

  it("requests configured reasoning summaries on every model turn", async () => {
    const root = await fixture();
    const model = new ScriptedModel([
      { id: "response-1", outputText: "Done.", toolCalls: [] },
    ]);
    const runner = new AgentRunner({
      model,
      modelName: "test-model",
      instructions: "test instructions",
      tools: createDefaultToolRegistry([]),
      toolContext: { workspaceRoot: root },
      approvalPolicy: new DenyAllApprovalPolicy(),
      reasoningSummary: "detailed",
    });

    await runner.run("explain the project");

    expect(model.requests[0]?.reasoningSummary).toBe("detailed");
  });

  it("forwards model deltas when streaming is enabled", async () => {
    const root = await fixture();
    const events: AgentEvent[] = [];
    const model: ModelAdapter = {
      async respond(request) {
        expect(request.stream).toBe(true);
        await request.onStreamEvent?.({
          type: "reasoning_summary_delta",
          delta: "Inspect the project.",
        });
        await request.onStreamEvent?.({ type: "output_text_delta", delta: "Done." });
        return {
          id: "response-streamed",
          outputText: "Done.",
          reasoningSummary: "Inspect the project.",
          toolCalls: [],
        };
      },
    };
    const runner = new AgentRunner({
      model,
      modelName: "test-model",
      instructions: "test instructions",
      tools: createDefaultToolRegistry([]),
      toolContext: { workspaceRoot: root },
      approvalPolicy: new DenyAllApprovalPolicy(),
      stream: true,
      onEvent(event) {
        events.push(event);
      },
    });

    const result = await runner.run("explain the project");

    expect(result.output).toBe("Done.");
    expect(events).toContainEqual({
      type: "model_reasoning_delta",
      step: 1,
      delta: "Inspect the project.",
    });
    expect(events).toContainEqual({ type: "model_output_delta", step: 1, delta: "Done." });
  });

  it("continues a conversation from a response ID supplied by the host", async () => {
    const root = await fixture();
    const model = new ScriptedModel([
      { id: "response-next", outputText: "Continued answer.", toolCalls: [] },
    ]);
    const runner = new AgentRunner({
      model,
      modelName: "test-model",
      instructions: "test instructions",
      tools: createDefaultToolRegistry(),
      toolContext: { workspaceRoot: root },
      approvalPolicy: new AllowAllApprovalPolicy(),
    });

    await runner.run("Follow up.", { previousResponseId: "response-previous" });

    expect(model.requests[0]?.previousResponseId).toBe("response-previous");
    expect(model.requests[0]?.instructions).toBe("test instructions");
  });

  it("replays local user and assistant messages when no response ID is available", async () => {
    const root = await fixture();
    const model = new ScriptedModel([
      { id: "response-next", outputText: "Continued answer.", toolCalls: [] },
    ]);
    const runner = new AgentRunner({
      model,
      modelName: "test-model",
      instructions: "test instructions",
      tools: createDefaultToolRegistry(),
      toolContext: { workspaceRoot: root },
      approvalPolicy: new AllowAllApprovalPolicy(),
    });

    await runner.run("Follow up.", {
      history: [
        { role: "user", content: "Earlier question." },
        { role: "assistant", content: "Earlier answer." },
      ],
    });

    expect(model.requests[0]?.previousResponseId).toBeUndefined();
    expect(model.requests[0]?.input).toEqual([
      { role: "user", content: "Earlier question." },
      { role: "assistant", content: "Earlier answer." },
      { role: "user", content: "Follow up." },
    ]);
  });

  it("rejects ambiguous continuation state", async () => {
    const root = await fixture();
    const runner = new AgentRunner({
      model: new ScriptedModel([]),
      modelName: "test-model",
      instructions: "test instructions",
      tools: createDefaultToolRegistry(),
      toolContext: { workspaceRoot: root },
      approvalPolicy: new AllowAllApprovalPolicy(),
    });

    await expect(runner.run("Follow up.", {
      previousResponseId: "response-previous",
      history: [{ role: "user", content: "Earlier question." }],
    })).rejects.toThrow("cannot be used together");
  });

  it("executes a tool call and sends its output to the next model turn", async () => {
    const root = await fixture();
    const model = new ScriptedModel([
      {
        id: "response-1",
        outputText: "",
        toolCalls: [{
          callId: "call-1",
          name: "read_file",
          arguments: JSON.stringify({ path: "hello.ts", lineStart: null, lineEnd: null }),
        }],
      },
      { id: "response-2", outputText: "The answer is 42.", toolCalls: [] },
    ]);
    const runner = new AgentRunner({
      model,
      modelName: "test-model",
      instructions: "test instructions",
      tools: createDefaultToolRegistry(),
      toolContext: { workspaceRoot: root },
      approvalPolicy: new AllowAllApprovalPolicy(),
    });

    const result = await runner.run("What is the answer?");

    expect(result.output).toBe("The answer is 42.");
    expect(result.steps).toBe(2);
    expect(model.requests[1]?.previousResponseId).toBe("response-1");
    expect(JSON.stringify(model.requests[1]?.input)).toContain("answer = 42");
    expect(model.requests[1]?.instructions).toBe("test instructions");
  });

  it("returns an approval denial to the model without editing the file", async () => {
    const root = await fixture();
    const model = new ScriptedModel([
      {
        id: "response-1",
        outputText: "",
        toolCalls: [{
          callId: "call-1",
          name: "replace_in_file",
          arguments: JSON.stringify({
            path: "hello.ts",
            oldText: "42",
            newText: "43",
            expectedOccurrences: 1,
          }),
        }],
      },
      { id: "response-2", outputText: "The edit was denied.", toolCalls: [] },
    ]);
    const runner = new AgentRunner({
      model,
      modelName: "test-model",
      instructions: "test",
      tools: createDefaultToolRegistry(),
      toolContext: { workspaceRoot: root },
      approvalPolicy: new DenyAllApprovalPolicy(),
    });

    await runner.run("Change the answer.");

    expect(await readFile(path.join(root, "hello.ts"), "utf8")).toContain("42");
    expect(JSON.stringify(model.requests[1]?.input)).toContain("User denied");
  });

  it("stops a tool loop at the configured turn limit", async () => {
    const root = await fixture();
    const toolResponse = (id: string): ModelResponse => ({
      id,
      outputText: "",
      toolCalls: [{
        callId: `call-${id}`,
        name: "list_directory",
        arguments: JSON.stringify({ path: ".", depth: 1, maxResults: 10 }),
      }],
    });
    const model = new ScriptedModel([toolResponse("1"), toolResponse("2")]);
    const runner = new AgentRunner({
      model,
      modelName: "test-model",
      instructions: "test",
      tools: createDefaultToolRegistry(),
      toolContext: { workspaceRoot: root },
      approvalPolicy: new AllowAllApprovalPolicy(),
      maxSteps: 2,
    });

    await expect(runner.run("Loop forever.")).rejects.toBeInstanceOf(AgentLimitError);
  });
});
