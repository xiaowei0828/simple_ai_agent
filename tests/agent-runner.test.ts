import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentLimitError, AgentResponseError } from "../src/core/agent-runner.js";
import { contextTokens, responseInputItems } from "../src/core/context-compaction.js";
import type {
  AgentEvent,
  ModelAdapter,
  ModelInputItem,
  ModelRequest,
  ModelResponse,
  ToolCallOutput,
} from "../src/core/types.js";
import { AllowAllApprovalPolicy, CallbackApprovalPolicy } from "../src/policy/approval-policy.js";
import { createDefaultToolRegistry } from "../src/tools/index.js";
import { ToolRegistry } from "../src/tools/types.js";
import { createTempDirectoryFixture, createTestRunner } from "./test-utils.js";

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
    { status: "incomplete", withTools: false }, { status: "incomplete", withTools: true },
    { status: "failed", withTools: false }, { status: "failed", withTools: true },
  ])("preserves $status responses (tools=$withTools) without completing or executing tools", async ({ status, withTools }) => {
    const events: AgentEvent[] = [];
    let executions = 0;
    const model = new ScriptedModel([{
      id: "partial", status, incompleteDetails: { reason: "max_output_tokens" }, outputText: "partial answer",
      toolCalls: withTools ? [{ callId: "a", name: "write", arguments: "{}" }] : [],
    }]);
    const runner = createTestRunner({
      model,
      tools: new ToolRegistry([{
        risk: "write", definition: { type: "function", name: "write", description: "test", parameters: {}, strict: false },
        parse: (input) => input, async execute() { executions++; },
      }]),
      approvalPolicy: new AllowAllApprovalPolicy(), onEvent(event) { events.push(event); },
    });
    await expect(runner.run("test")).rejects.toThrow(`status=${status}, reason=max_output_tokens`);
    expect(executions).toBe(0);
    expect(events.some((event) => event.type === "model_response" && event.response.outputText === "partial answer")).toBe(true);
    expect(events.some((event) => event.type === "run_completed")).toBe(false);
  });

  it.each(["tool_completed", "tool_output", "serialization"])("stops on %s failure without reporting a completed action as failed", async (failure) => {
    const events: AgentEvent[] = [];
    let executions = 0;
    const model = new ScriptedModel([{
      id: "calls", outputText: "", toolCalls: [
        { callId: "a", name: "write", arguments: "{}" },
        { callId: "b", name: "write", arguments: "{}" },
      ],
    }]);
    const runner = createTestRunner({
      model,
      tools: new ToolRegistry([{
        risk: "write", definition: { type: "function", name: "write", description: "test", parameters: {}, strict: false },
        parse: (input) => input,
        async execute() {
          executions++;
          return failure === "serialization" ? { toJSON() { throw new Error("serialization failed"); } } : "saved";
        },
      }]),
      approvalPolicy: new AllowAllApprovalPolicy(),
      onEvent(event) {
        if (event.type === failure) throw new Error(`${failure} failed`);
        events.push(event);
      },
    });
    await expect(runner.run("test")).rejects.toThrow(`${failure} failed`);
    expect(executions).toBe(1);
    expect(model.requests).toHaveLength(1);
    expect(events.some((event) => event.type === "tool_failed")).toBe(false);
    const outputs = events.filter((event) => event.type === "tool_output");
    if (failure === "tool_completed") {
      expect(outputs).toHaveLength(1);
      expect(JSON.parse(outputs[0]!.output.output)).toEqual({ ok: true, result: "saved" });
    } else {
      expect(outputs).toHaveLength(0);
    }
  });

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
    const runner = createTestRunner({
      model, modelName: "default-model", instructions, tools,
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
    const model = new ScriptedModel([
      { id: "response-override", outputText: "Done.", toolCalls: [] },
    ]);
    const runner = createTestRunner({
      model,
      modelName: "default-model",
    });

    await runner.run("use another model", { model: "selected-model" });

    expect(model.requests[0]?.model).toBe("selected-model");
  });

  it("requests automatic reasoning summaries on every model turn", async () => {
    const model = new ScriptedModel([
      { id: "response-1", outputText: "Done.", toolCalls: [] },
    ]);
    const runner = createTestRunner({
      model,
    });

    await runner.run("explain the project");

    expect(model.requests[0]?.reasoningSummary).toBe("auto");
  });

  it("streams by default and forwards model deltas", async () => {
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
    const runner = createTestRunner({
      model,
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
    const model = new ScriptedModel([
      { id: "response-1", outputText: "Done.", toolCalls: [] },
    ]);
    const runner = createTestRunner({
      model, instructions: "test",
      stream: false,
    });
    await runner.run("Explain the project.");
    expect(model.requests[0]?.stream).toBe(false);
    expect(model.requests[0]?.onStreamEvent).toBeUndefined();
  });

  it("continues a conversation from a response ID supplied by the host", async () => {
    const model = new ScriptedModel([
      { id: "response-next", outputText: "Continued answer.", toolCalls: [] },
    ]);
    const runner = createTestRunner({
      model,
      approvalPolicy: new AllowAllApprovalPolicy(),
    });

    await runner.run("Follow up.", { previousResponseId: "response-previous" });

    expect(model.requests[0]?.previousResponseId).toBe("response-previous");
    expect(model.requests[0]?.instructions).toBe("test instructions");
  });

  it("replays local user and assistant messages when no response ID is available", async () => {
    const model = new ScriptedModel([
      { id: "response-next", outputText: "Continued answer.", toolCalls: [] },
    ]);
    const runner = createTestRunner({
      model,
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
    const model = new ScriptedModel([{ id: "next", outputText: "done", toolCalls: [] }]);
    const runner = createTestRunner({
      model,
      approvalPolicy: new AllowAllApprovalPolicy(),
    });

    await runner.run("Follow up.", {
      previousResponseId: "response-previous",
      history: [{ role: "user", content: "Earlier question." }],
    });
    expect(model.requests[0]).toMatchObject({ previousResponseId: "response-previous", input: "Follow up." });
  });

  it("returns a retry checkpoint when the first model request fails after a known response", async () => {
    const requests: ModelRequest[] = [];
    const failure = new TypeError("connection terminated");
    const runner = createTestRunner({
      model: { async respond(request) { requests.push(request); throw failure; } },
      approvalPolicy: new AllowAllApprovalPolicy(),
    });

    const thrown = await runner.run(" Follow up. ", {
      previousResponseId: "response-previous",
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(AgentResponseError);
    expect(thrown).toMatchObject({
      message: "connection terminated",
      continuation: {
        previousResponseId: "response-previous",
        pendingInput: "Follow up.",
      },
    });
    expect((thrown as AgentResponseError).cause).toBe(failure);
    expect(requests[0]?.input).toBe("Follow up.");
  });

  it("checkpoints saved tool outputs and resumes without executing the tool again", async () => {
    const requests: ModelRequest[] = [];
    const savedOutputs: ToolCallOutput[] = [];
    let modelCall = 0;
    let executions = 0;
    const runner = createTestRunner({
      model: {
        async respond(request) {
          requests.push(request);
          modelCall += 1;
          if (modelCall === 1) {
            return {
              id: "response-tools",
              outputText: "",
              toolCalls: [{ callId: "call-1", name: "save_result", arguments: "{}" }],
            };
          }
          if (modelCall === 2) throw new TypeError("connection terminated");
          return { id: "response-done", outputText: "Done.", toolCalls: [] };
        },
      },
      tools: new ToolRegistry([{
        definition: {
          type: "function", name: "save_result", description: "fixture",
          parameters: {}, strict: false,
        },
        risk: "write",
        parse(input: unknown) { return input; },
        async execute() { executions += 1; return { saved: true }; },
      }]),
      approvalPolicy: new AllowAllApprovalPolicy(),
      onEvent(event) {
        if (event.type === "tool_output") savedOutputs.push(event.output);
      },
    });

    const failure = await runner.run("Save once.").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AgentResponseError);
    const continuation = (failure as AgentResponseError).continuation;
    expect(continuation).toEqual({
      previousResponseId: "response-tools",
      pendingInput: savedOutputs,
    });

    const result = await runner.run("Continue with the saved result.", {
      ...continuation,
      history: [
        { role: "user", content: "Large local history stays local." },
        { role: "assistant", content: "Earlier answer." },
      ],
    });

    expect(result.output).toBe("Done.");
    expect(executions).toBe(1);
    expect(requests[2]?.previousResponseId).toBe("response-tools");
    expect(requests[2]?.input).toEqual([
      ...savedOutputs,
      { role: "user", content: "Continue with the saved result." },
    ]);
  });

  it("does not issue another checkpoint when a continuation's first request fails", async () => {
    const requests: ModelRequest[] = [];
    const failure = new TypeError("still offline");
    const runner = createTestRunner({
      model: { async respond(request) { requests.push(request); throw failure; } },
      approvalPolicy: new AllowAllApprovalPolicy(),
    });

    const thrown = await runner.run("New request.", {
      previousResponseId: "response-previous",
      pendingInput: "Interrupted request.",
    }).catch((error: unknown) => error);

    expect(thrown).toBe(failure);
    expect(requests[0]?.input).toEqual([
      { role: "user", content: "Interrupted request." },
      { role: "user", content: "New request." },
    ]);
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
    const runner = createTestRunner({
      model,
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
    const runner = createTestRunner({
      model, modelName: "test", instructions: "test",
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

  it("shares one output budget across every tool call in a model step", async () => {
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
        return input as { fail: boolean; label: string };
      },
      async execute(input: { fail: boolean; label: string }) {
        const content = `${input.label}-BEGIN-${"x".repeat(2_000)}-${input.label}-END`;
        if (input.fail) throw new Error(content);
        return { content };
      },
    }]);
    const calls = [
      { callId: "first", name: "large_output", arguments: JSON.stringify({ fail: false, label: "A" }) },
      { callId: "second", name: "large_output", arguments: JSON.stringify({ fail: false, label: "B" }) },
      { callId: "third", name: "large_output", arguments: JSON.stringify({ fail: true, label: "C" }) },
    ];
    const model = new ScriptedModel([
      { id: "response-1", outputText: "", toolCalls: calls },
      { id: "response-2", outputText: "Done.", toolCalls: [] },
    ]);
    const maxToolOutputCharsPerStep = 600;
    const runner = createTestRunner({
      model, tools,
      approvalPolicy: new AllowAllApprovalPolicy(),
      maxToolOutputChars: 400,
      maxToolOutputCharsPerStep,
    });

    await runner.run("Produce a batch of large outputs.");

    const outputs = functionCallOutputs(model.requests[1]);
    expect(outputs.map((output) => output.call_id)).toEqual(calls.map((call) => call.callId));
    expect(outputs.reduce((total, output) => total + output.output.length, 0))
      .toBeLessThanOrEqual(maxToolOutputCharsPerStep);
    expect(outputs.map((output) => {
      const parsed = JSON.parse(output.output) as { ok: boolean; truncated: boolean };
      return { ok: parsed.ok, truncated: parsed.truncated };
    })).toEqual([
      { ok: true, truncated: true },
      { ok: true, truncated: true },
      { ok: false, truncated: true },
    ]);
  });

  it("preserves every call pairing when minimal status envelopes exceed the step budget", async () => {
    let executions = 0;
    const tools = new ToolRegistry([{
      definition: {
        type: "function",
        name: "large_output",
        description: "Return a large test payload.",
        parameters: { type: "object" },
        strict: true,
      },
      risk: "execute",
      parse(input: unknown) {
        return input;
      },
      async execute() {
        executions += 1;
        return "x".repeat(2_000);
      },
    }]);
    const calls = Array.from({ length: 5 }, (_, index) => ({
      callId: `call-${index}`,
      name: "large_output",
      arguments: "{}",
    }));
    const model = new ScriptedModel([
      { id: "response-1", outputText: "", toolCalls: calls },
      { id: "response-2", outputText: "Done.", toolCalls: [] },
    ]);
    const runner = createTestRunner({
      model, tools,
      approvalPolicy: new AllowAllApprovalPolicy(),
      maxToolOutputCharsPerStep: 128,
    });

    await runner.run("Produce more calls than the minimal step budget can hold.");

    const outputs = functionCallOutputs(model.requests[1]);
    const minimalEnvelopeChars = JSON.stringify({ ok: false, truncated: true }).length;
    expect(executions).toBe(calls.length);
    expect(outputs.map((output) => output.call_id)).toEqual(calls.map((call) => call.callId));
    expect(outputs.reduce((total, output) => total + output.output.length, 0))
      .toBeLessThanOrEqual(calls.length * minimalEnvelopeChars);
    for (const output of outputs) {
      expect(JSON.parse(output.output)).toEqual({ ok: true, truncated: true });
    }
  });

  it("bounds command output once while preserving process status", async () => {
    const root = await createTempDirectory("agent-command-output-");
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
    const runner = createTestRunner({
      model,
      tools: createDefaultToolRegistry(),
      toolContext: { workspaceRoot: root },
      approvalPolicy: new AllowAllApprovalPolicy(),
      maxToolOutputChars: 600,
    });

    await runner.run("Read the file.");

    const [toolOutput] = functionCallOutputs(model.requests[1]);
    const parsed = JSON.parse(toolOutput?.output ?? "") as {
      ok: boolean;
      truncated: boolean;
      result: { output: string; exitCode: number; timedOut: boolean; truncated: boolean };
    };
    expect(toolOutput?.output.length).toBeLessThanOrEqual(600);
    expect(parsed.ok).toBe(true);
    expect(parsed.truncated).toBe(true);
    expect(parsed.result.output).toContain("…[truncated]…");
    expect(parsed.result.exitCode).toBe(0);
    expect(parsed.result.timedOut).toBe(false);
    expect(parsed.result.truncated).toBe(false);
  });

  it.each(["maxToolOutputChars", "maxToolOutputCharsPerStep"] as const)("rejects an undersized %s budget", (setting) => {
    expect(() => createTestRunner({ model: new ScriptedModel([]), [setting]: 127 }))
      .toThrow(`${setting} must be an integer of at least 128`);
  });

  it("applies a patch only after approval and returns the change summary to the model", async () => {
    const root = await fixture();
    const patch = "*** Begin Patch\n*** Update File: hello.ts\n@@\n-export const answer = 42;\n+export const answer = 43;\n*** End Patch";
    let approved = false;
    const model = new ScriptedModel([
      { id: "response-1", outputText: "", toolCalls: [{ callId: "patch-1", name: "apply_patch", arguments: JSON.stringify({ patch }) }] },
      { id: "response-2", outputText: "Edited.", toolCalls: [] },
    ]);
    const runner = createTestRunner({
      model, instructions: "test",
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
    const runner = createTestRunner({
      model,
      instructions: "test",
      tools: createDefaultToolRegistry(),
      toolContext: { workspaceRoot: root },
    });

    await runner.run("Change the answer.");

    expect(await readFile(path.join(root, "hello.ts"), "utf8")).toContain("42");
    expect(JSON.stringify(model.requests[1]?.input)).toContain("User denied");
  });

  it("stops a tool loop at the configured turn limit", async () => {
    let executions = 0;
    const toolResponse = (id: string): ModelResponse => ({
      id,
      outputText: "",
      toolCalls: [{
        callId: `call-${id}`,
        name: "loop",
        arguments: "{}",
      }],
    });
    const model = new ScriptedModel([toolResponse("1"), toolResponse("2")]);
    const runner = createTestRunner({
      model,
      tools: new ToolRegistry([{
        risk: "execute", definition: { type: "function", name: "loop", description: "fixture", parameters: {}, strict: false },
        parse: (input) => input, async execute() { executions++; return "continue"; },
      }]),
      approvalPolicy: new AllowAllApprovalPolicy(),
      maxSteps: 2,
    });

    await expect(runner.run("Loop forever.")).rejects.toBeInstanceOf(AgentLimitError);
    expect(executions).toBe(2);
    expect(model.requests).toHaveLength(2);
  });
});
