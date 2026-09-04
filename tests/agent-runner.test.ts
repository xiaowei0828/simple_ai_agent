import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentLimitError, AgentRunner } from "../src/core/agent-runner.js";
import { contextTokens, responseInputItems } from "../src/core/context-compaction.js";
import type {
  AgentEvent,
  ModelAdapter,
  ModelInputItem,
  ModelRequest,
  ModelResponse,
  ToolCallOutput,
} from "../src/core/types.js";
import { AllowAllApprovalPolicy, CallbackApprovalPolicy, DenyAllApprovalPolicy } from "../src/policy/approval-policy.js";
import { createDefaultToolRegistry } from "../src/tools/index.js";
import { ToolRegistry } from "../src/tools/types.js";
import { createTempDirectoryFixture } from "./test-utils.js";

const createTempDirectory = createTempDirectoryFixture();

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
  const root = await createTempDirectory("simple-code-agent-");
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
  it.each([
    { usage: { total_tokens: 7_000 }, contextWindow: 10_000, measured: 7_000 },
    { usage: { input_tokens: 6_000, output_tokens: 1_000 }, contextWindow: 10_000, measured: 7_000 },
    { usage: undefined, contextWindow: 10_000, measured: 0 },
    { usage: undefined, contextWindow: undefined, measured: 0 },
  ])("reports active context using usage or local estimates (case %#)", async ({ usage, contextWindow, measured }) => {
    const response: ModelResponse = { id: "next", outputText: "Done.", toolCalls: [], usage };
    const model = new ScriptedModel([response]);
    const events: AgentEvent[] = [];
    const history: ModelInputItem[] = [
      { role: "user", content: "Earlier request." },
      { role: "assistant", content: "Earlier progress." },
    ];
    const summary = "Previous checkpoint.";
    const instructions = "test instructions";
    const tools = createDefaultToolRegistry();
    const runner = new AgentRunner({
      model, modelName: "default-model", instructions, tools,
      toolContext: { workspaceRoot: process.cwd() }, approvalPolicy: new DenyAllApprovalPolicy(),
      contextWindow: (name) => name === "selected-model" ? contextWindow : 20_000,
      onEvent(event) { events.push(event); },
    });

    await runner.run("Continue.", { model: "selected-model", history, summary });

    const local = contextTokens([
      ...history, { role: "user", content: "Continue." }, ...responseInputItems(response),
    ], summary, instructions, tools.definitions());
    expect(events.find((event) => event.type === "model_response")).toMatchObject({
      step: 1, response,
      context: { tokens: Math.max(local, measured) },
    });
    const status = events.find((event) => event.type === "model_response")?.context;
    if (contextWindow === undefined) {
      expect(status).not.toHaveProperty("contextWindow");
      expect(status).not.toHaveProperty("triggerTokens");
    } else {
      expect(status).toMatchObject({ contextWindow: 10_000, triggerTokens: 8_000 });
    }
  });

  it("allows one run to override the configured model", async () => {
    const root = await fixture();
    const model = new ScriptedModel([
      { id: "response-override", outputText: "Done.", toolCalls: [] },
    ]);
    const runner = new AgentRunner({
      model,
      modelName: "default-model",
      instructions: "test instructions",
      tools: createDefaultToolRegistry(),
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
      tools: createDefaultToolRegistry(),
      toolContext: { workspaceRoot: root },
      approvalPolicy: new DenyAllApprovalPolicy(),
      reasoningSummary: "detailed",
    });

    await runner.run("explain the project");

    expect(model.requests[0]?.reasoningSummary).toBe("detailed");
  });

  it("streams by default and forwards model deltas", async () => {
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
      tools: createDefaultToolRegistry(),
      toolContext: { workspaceRoot: root },
      approvalPolicy: new DenyAllApprovalPolicy(),
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

  it("allows the host to explicitly disable streaming", async () => {
    const root = await fixture();
    const model = new ScriptedModel([
      { id: "response-1", outputText: "Done.", toolCalls: [] },
    ]);
    const runner = new AgentRunner({
      model, modelName: "test-model", instructions: "test",
      tools: createDefaultToolRegistry(),
      toolContext: { workspaceRoot: root },
      approvalPolicy: new DenyAllApprovalPolicy(),
      stream: false,
    });
    await runner.run("Explain the project.");
    expect(model.requests[0]?.stream).toBe(false);
    expect(model.requests[0]?.onStreamEvent).toBeUndefined();
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

  it("keeps local history without duplicating it in response-ID requests", async () => {
    const root = await fixture();
    const model = new ScriptedModel([{ id: "next", outputText: "done", toolCalls: [] }]);
    const runner = new AgentRunner({
      model,
      modelName: "test-model",
      instructions: "test instructions",
      tools: createDefaultToolRegistry(),
      toolContext: { workspaceRoot: root },
      approvalPolicy: new AllowAllApprovalPolicy(),
    });

    await runner.run("Follow up.", {
      previousResponseId: "response-previous",
      history: [{ role: "user", content: "Earlier question." }],
    });
    expect(model.requests[0]).toMatchObject({ previousResponseId: "response-previous", input: "Follow up." });
  });

  it("executes a tool call and sends its output to the next model turn", async () => {
    const root = await fixture();
    const model = new ScriptedModel([
      {
        id: "response-1",
        outputText: "",
        toolCalls: [{
          callId: "call-1",
          name: "run_command",
          arguments: JSON.stringify({
            command: process.platform === "win32" ? "Get-Content hello.ts" : "cat hello.ts",
            cwd: ".",
            timeoutMs: 10_000,
          }),
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

  it("approves, executes, and saves each tool result before starting the next tool", async () => {
    const events: string[] = [];
    const model = new ScriptedModel([
      { id: "tools", outputText: "", toolCalls: [
        { callId: "a", name: "write", arguments: "{}" },
        { callId: "b", name: "execute", arguments: "{}" },
      ] },
      { id: "done", outputText: "Done.", toolCalls: [] },
    ]);
    const runner = new AgentRunner({
      model, modelName: "test", instructions: "test",
      toolContext: { workspaceRoot: process.cwd() },
      tools: new ToolRegistry((["write", "execute"] as const).map((risk) => ({
        risk,
        definition: { type: "function", name: risk, description: "fixture", parameters: {}, strict: false },
        parse: () => ({}),
        async execute() { events.push(`execute:${risk}`); return risk; },
      }))),
      approvalPolicy: {
        async approve(request) { events.push(`approve:${request.toolName}`); return true; },
      },
      async onEvent(event) {
        if (event.type === "tool_output") {
          await Promise.resolve();
          events.push(`saved:${event.output.call_id}`);
        }
      },
    });
    await runner.run("Keep tool operations ordered.");
    expect(events).toEqual([
      "approve:write", "execute:write", "saved:a",
      "approve:execute", "execute:execute", "saved:b",
    ]);
    expect(functionCallOutputs(model.requests[1]).map((output) => output.call_id)).toEqual(["a", "b"]);
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
      risk: "execute",
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

  it("preserves command status when the runner trims long command output", async () => {
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
          name: "run_command",
          arguments: JSON.stringify({ command: "node -e \"process.stdout.write(require('fs').readFileSync('many-lines.txt', 'utf8'))\"" }),
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
      result: { output: string; exitCode: number; timedOut: boolean };
    };
    expect(toolOutput?.output.length).toBeLessThanOrEqual(600);
    expect(parsed.truncated).toBe(true);
    expect(parsed.result.output).toContain("…[truncated]…");
    expect(parsed.result.exitCode).toBe(0);
    expect(parsed.result.timedOut).toBe(false);
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

  it("applies a patch only after approval and returns the change summary to the model", async () => {
    const root = await fixture();
    const patch = "*** Begin Patch\n*** Update File: hello.ts\n@@\n-export const answer = 42;\n+export const answer = 43;\n*** End Patch";
    let approved = false;
    const model = new ScriptedModel([
      { id: "response-1", outputText: "", toolCalls: [{ callId: "patch-1", name: "apply_patch", arguments: JSON.stringify({ patch }) }] },
      { id: "response-2", outputText: "Edited.", toolCalls: [] },
    ]);
    const runner = new AgentRunner({
      model, modelName: "test-model", instructions: "test",
      tools: createDefaultToolRegistry(),
      toolContext: { workspaceRoot: root },
      approvalPolicy: new CallbackApprovalPolicy(async (request) => {
        expect(request).toMatchObject({ toolName: "apply_patch", risk: "write", arguments: { patch } });
        expect(await readFile(path.join(root, "hello.ts"), "utf8")).toBe("export const answer = 42;\n");
        approved = true;
        return true;
      }),
    });
    await runner.run("Change the answer.");
    expect(approved).toBe(true);
    expect(await readFile(path.join(root, "hello.ts"), "utf8")).toBe("export const answer = 43;\n");
    expect(JSON.parse(functionCallOutputs(model.requests[1])[0]!.output)).toMatchObject({
      ok: true, result: { changedFiles: 1, changes: [{ path: "hello.ts", operation: "update" }] },
    });
  });

  it("returns an approval denial to the model without editing the file", async () => {
    const root = await fixture();
    const model = new ScriptedModel([
      {
        id: "response-1",
        outputText: "",
        toolCalls: [{
          callId: "call-1",
          name: "apply_patch",
          arguments: JSON.stringify({
            patch: "*** Begin Patch\n*** Update File: hello.ts\n@@\n-export const answer = 42;\n+export const answer = 43;\n*** End Patch",
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
        name: "run_command",
        arguments: JSON.stringify({ command: "node --version" }),
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
