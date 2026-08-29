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
  ToolCallOutput,
} from "../src/core/types.js";
import { AllowAllApprovalPolicy, DenyAllApprovalPolicy } from "../src/policy/approval-policy.js";
import { createDefaultToolRegistry } from "../src/tools/index.js";
import { ToolRegistry } from "../src/tools/types.js";

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

function functionCallOutputs(request: ModelRequest | undefined): ToolCallOutput[] {
  if (!request || !Array.isArray(request.input)) {
    throw new Error("Expected the next model request to contain tool outputs.");
  }
  return request.input.filter((item): item is ToolCallOutput => (
    "type" in item && item.type === "function_call_output"
  ));
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
          type: "reasoning_text_delta",
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
    const [toolOutput] = functionCallOutputs(model.requests[1]);
    const parsedOutput = JSON.parse(toolOutput?.output ?? "") as Record<string, unknown>;
    expect(parsedOutput.ok).toBe(true);
    expect(parsedOutput).not.toHaveProperty("truncated");
  });

  it("returns every tool output from a parallel batch in model order", async () => {
    const root = await fixture();
    const model = new ScriptedModel([
      {
        id: "response-1",
        outputText: "",
        toolCalls: [
          {
            callId: "call-read",
            name: "read_file",
            arguments: JSON.stringify({ path: "hello.ts", lineStart: null, lineEnd: null }),
          },
          {
            callId: "call-list",
            name: "list_directory",
            arguments: JSON.stringify({ path: ".", depth: 1, maxResults: 10 }),
          },
        ],
      },
      { id: "response-2", outputText: "Done.", toolCalls: [] },
    ]);
    const runner = new AgentRunner({
      model,
      modelName: "test-model",
      instructions: "test instructions",
      tools: createDefaultToolRegistry(),
      toolContext: { workspaceRoot: root },
      approvalPolicy: new AllowAllApprovalPolicy(),
    });

    await runner.run("Inspect the workspace.");

    expect(model.requests[1]?.input).toEqual([
      expect.objectContaining({ type: "function_call_output", call_id: "call-read" }),
      expect.objectContaining({ type: "function_call_output", call_id: "call-list" }),
    ]);
  });

  it("keeps truncated success and error outputs within the limit as valid JSON", async () => {
    const root = await fixture();
    const tools = new ToolRegistry([{
      definition: {
        type: "function",
        name: "large_output",
        description: "Return or throw a large test payload.",
        parameters: { type: "object" },
        strict: true,
      },
      risk: "read",
      parse(input: unknown) {
        return input as { fail: boolean };
      },
      async execute(input: { fail: boolean }) {
        const content = `BEGIN-${"x".repeat(2_000)}-END`;
        if (input.fail) throw new Error(content);
        return { content };
      },
    }]);
    const model = new ScriptedModel([
      {
        id: "response-1",
        outputText: "",
        toolCalls: [
          {
            callId: "call-success",
            name: "large_output",
            arguments: JSON.stringify({ fail: false }),
          },
          {
            callId: "call-error",
            name: "large_output",
            arguments: JSON.stringify({ fail: true }),
          },
        ],
      },
      { id: "response-2", outputText: "Done.", toolCalls: [] },
    ]);
    const maxToolOutputChars = 400;
    const runner = new AgentRunner({
      model,
      modelName: "test-model",
      instructions: "test instructions",
      tools,
      toolContext: { workspaceRoot: root },
      approvalPolicy: new AllowAllApprovalPolicy(),
      maxToolOutputChars,
    });

    await runner.run("Produce large outputs.");

    const [successOutput, errorOutput] = functionCallOutputs(model.requests[1]);
    expect(successOutput?.output.length).toBeLessThanOrEqual(maxToolOutputChars);
    expect(errorOutput?.output.length).toBeLessThanOrEqual(maxToolOutputChars);

    const success = JSON.parse(successOutput?.output ?? "") as Record<string, unknown>;
    expect(success).toMatchObject({
      ok: true,
      truncated: true,
      originalOutputChars: expect.any(Number),
      truncation: {
        strategy: "structured",
        truncatedStrings: 1,
        omittedStringChars: expect.any(Number),
      },
    });
    const successResult = success.result as { content: string };
    expect(successResult.content).toEqual(expect.stringMatching(/^BEGIN-/));
    expect(successResult.content).toEqual(expect.stringMatching(/-END$/));

    const failure = JSON.parse(errorOutput?.output ?? "") as Record<string, unknown>;
    expect(failure).toMatchObject({
      ok: false,
      truncated: true,
      originalOutputChars: expect.any(Number),
      omittedErrorChars: expect.any(Number),
    });
    expect(failure.error).toEqual(expect.stringMatching(/^BEGIN-/));
    expect(failure.error).toEqual(expect.stringMatching(/-END$/));
  });

  it("preserves read_file continuation metadata when the runner trims its content", async () => {
    const root = await fixture();
    await writeFile(
      path.join(root, "many-lines.txt"),
      Array.from({ length: 600 }, (_, index) => `line ${index + 1}`).join("\n"),
      "utf8",
    );
    const model = new ScriptedModel([
      {
        id: "response-1",
        outputText: "",
        toolCalls: [{
          callId: "call-read",
          name: "read_file",
          arguments: JSON.stringify({
            path: "many-lines.txt",
            lineStart: null,
            lineEnd: null,
          }),
        }],
      },
      { id: "response-2", outputText: "Done.", toolCalls: [] },
    ]);
    const runner = new AgentRunner({
      model,
      modelName: "test-model",
      instructions: "test instructions",
      tools: createDefaultToolRegistry(),
      toolContext: { workspaceRoot: root },
      approvalPolicy: new AllowAllApprovalPolicy(),
      maxToolOutputChars: 600,
    });

    await runner.run("Read the file.");

    const [toolOutput] = functionCallOutputs(model.requests[1]);
    const parsed = JSON.parse(toolOutput?.output ?? "") as {
      truncated: boolean;
      result: { content: string; nextLine: number; truncatedBy: string };
    };
    expect(toolOutput?.output.length).toBeLessThanOrEqual(600);
    expect(parsed.truncated).toBe(true);
    expect(parsed.result.content).toContain("…[truncated]…");
    expect(parsed.result.nextLine).toBe(501);
    expect(parsed.result.truncatedBy).toBe("line_limit");
  });

  it("rejects a tool output budget too small for a structured truncation envelope", async () => {
    const root = await fixture();

    expect(() => new AgentRunner({
      model: new ScriptedModel([]),
      modelName: "test-model",
      instructions: "test instructions",
      tools: createDefaultToolRegistry(),
      toolContext: { workspaceRoot: root },
      approvalPolicy: new AllowAllApprovalPolicy(),
      maxToolOutputChars: 127,
    })).toThrow("at least 128");
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
