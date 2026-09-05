import { appendFile, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import type { ModelAdapter, ModelRequest, ModelResponse } from "../src/core/types.js";
import { runInteractiveSession } from "../src/cli/interactive-session.js";
import { JsonlConversationStore, parseSessionEntries, replayConversation } from "../src/history/session-store.js";
import { OpenAIModel } from "../src/model/openai-model.js";
import { AllowAllApprovalPolicy, DenyAllApprovalPolicy } from "../src/policy/approval-policy.js";
import { ToolRegistry } from "../src/tools/types.js";
import { parseOpenAITraceJsonl } from "../src/trace-viewer/parse-trace.js";
import { createTempDirectoryFixture, scriptedIO, createTestRunner } from "./test-utils.js";

const createTempDirectory = createTempDirectoryFixture();
async function fixture() {
  const root = await createTempDirectory("simple-code-agent-journal-");
  return { root, directory: path.join(root, ".agent-runs") };
}

const response = (id: string, text = "done"): ModelResponse => ({ id, outputText: text, toolCalls: [] });

describe("unified session journal", () => {
  it.each(["completed", "interrupted"] as const)("resumes %s tool work locally without rerunning completed tools", async (status) => {
    const completed = status === "completed";
    const { root, directory } = await fixture();
    const store = new JsonlConversationStore(directory);
    let executions = 0;
    const tools = new ToolRegistry([{
      definition: { type: "function", name: "write_marker", description: "fixture", parameters: {}, strict: false },
      risk: "write", parse: (input) => input,
      async execute() { executions++; await writeFile(path.join(root, "marker"), "saved"); return { text: "saved" }; },
    }]);
    let requests = 0;
    const model: ModelAdapter = { async respond() {
      if (++requests === 2) {
        const [saved] = await store.list();
        expect((await store.load(saved!.id)).context).toContainEqual(expect.objectContaining({ type: "function_call_output", call_id: "call-1" }));
        if (completed) return response("response-before-exit", "marker saved");
        throw new TypeError("terminated");
      }
      return {
        id: "response-1", outputText: "", toolCalls: [{ callId: "call-1", name: "write_marker", arguments: "{}" }],
        outputItems: [
          { type: "reasoning", id: "reason-1", summary: [], encrypted_content: "opaque-provider-state" },
          { type: "function_call", call_id: "call-1", name: "write_marker", arguments: "{}" },
        ],
      };
    } };
    const runner = createTestRunner({ model, instructions: "fixture", tools,
      toolContext: { workspaceRoot: root }, approvalPolicy: new AllowAllApprovalPolicy(),
      onEvent: (event) => store.recordAgentEvent(event) });
    await runInteractiveSession({ agent: runner, initialModel: "test-model", historyStore: store, io: scriptedIO(["write a marker", "/exit"]) });
    const [saved] = await store.list();
    expect(saved).toMatchObject({ status: completed ? "idle" : "failed", turnCount: completed ? 1 : 0 });
    const before = await readFile(store.filePath(saved!.id), "utf8");
    expect(before).not.toContain('"openai.');
    const beforeReport = parseOpenAITraceJsonl(before);
    expect(beforeReport.turns).toHaveLength(2);
    expect(beforeReport.totals).toMatchObject({ toolCalls: 1, errors: completed ? 0 : 1 });
    expect(beforeReport.turns[0]?.toolCalls[0]?.result?.ok).toBe(true);

    const reopened = new JsonlConversationStore(directory);
    const continuedRequests: ModelRequest[] = [];
    const continued = createTestRunner({
      model: { async respond(request) { continuedRequests.push(request); return response("response-2"); } },
      instructions: "fixture", tools, toolContext: { workspaceRoot: root },
      approvalPolicy: new AllowAllApprovalPolicy(), onEvent: (event) => reopened.recordAgentEvent(event),
    });
    await runInteractiveSession({ agent: continued, initialModel: "test-model", historyStore: reopened, io: scriptedIO(["1", "continue", "/exit"]) });
    expect(executions).toBe(1);
    expect(continuedRequests).toHaveLength(1);
    expect(continuedRequests[0]?.previousResponseId).toBeUndefined();
    expect(continuedRequests[0]?.input).toEqual([
      { role: "user", content: "write a marker" },
      { type: "reasoning", id: "reason-1", summary: [], encrypted_content: "opaque-provider-state" },
      { type: "function_call", call_id: "call-1", name: "write_marker", arguments: "{}" },
      { type: "function_call_output", call_id: "call-1", output: JSON.stringify({ ok: true, result: { text: "saved" } }) },
      ...(completed ? [{ role: "assistant", content: "marker saved" }] : []),
      { role: "user", content: "continue" },
    ]);
    expect(await readdir(directory)).toEqual([`${saved!.id}.jsonl`]);
    expect((await reopened.load(saved!.id)).status).toBe("idle");
    expect(parseOpenAITraceJsonl(await readFile(reopened.filePath(saved!.id), "utf8")).turns).toHaveLength(3);
  });

  it("records denied and unknown tools before a subsequent request fails", async () => {
    const { root, directory } = await fixture();
    const store = new JsonlConversationStore(directory);
    const session = await store.create({ model: "test", title: "denials" });
    await store.beginTurn(session.id, "work");
    let count = 0;
    const runner = createTestRunner({
      model: { async respond() {
        if (count++) throw new Error("offline");
        return { id: "r1", outputText: "", toolCalls: [
          { callId: "a", name: "unknown", arguments: "{}" },
          { callId: "b", name: "write", arguments: "{}" },
        ] };
      } }, modelName: "test", instructions: "fixture", toolContext: { workspaceRoot: root },
      tools: new ToolRegistry([{ definition: { type: "function", name: "write", description: "fixture", parameters: {}, strict: false }, risk: "write", parse: (x) => x,
        async execute() { throw new Error("must not execute"); } }]),
      approvalPolicy: new DenyAllApprovalPolicy(), onEvent: (event) => store.recordAgentEvent(event),
    });
    await expect(runner.run("work")).rejects.toThrow("offline");
    const context = replayConversation(await store.load(session.id));
    const outputs = context.filter((item) => "type" in item && item.type === "function_call_output");
    expect(outputs).toHaveLength(2);
    expect(JSON.stringify(outputs)).toContain("User denied this tool call");
    expect(JSON.stringify(outputs)).toContain("Unknown tool: unknown");
  });

  it("marks a missing tool outcome as unknown when reconstructing context", async () => {
    const { directory } = await fixture();
    const store = new JsonlConversationStore(directory);
    const session = await store.create({ model: "test", title: "interrupted" });
    await store.beginTurn(session.id, "work");
    await store.recordAgentEvent({ type: "model_response", step: 1, response: {
      id: "r1", outputText: "", toolCalls: [{ callId: "a", name: "write", arguments: "{}" }],
    } });
    const loaded = await new JsonlConversationStore(directory).load(session.id);
    expect(loaded.status).toBe("running");
    expect(replayConversation(loaded).at(-1)).toMatchObject({ type: "function_call_output", call_id: "a", output: expect.stringContaining("outcome is unknown") });
  });

  it("saves raw SSE and the disconnect cause in the same journal", async () => {
    const { directory } = await fixture();
    const store = new JsonlConversationStore(directory);
    const session = await store.create({ model: "test", title: "stream failure" });
    await store.beginTurn(session.id, "hello");
    await store.recordAgentEvent({ type: "model_requested", step: 1, model: "test" });
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const delta = { type: "response.output_text.delta", item_id: "msg", output_index: 0, content_index: 0, delta: "partial", sequence_number: 0 };
    const client = new OpenAI({ apiKey: "fixture-key", baseURL: "https://example.test/v1", maxRetries: 0,
      fetch: async () => new Response(new ReadableStream<Uint8Array>({ start(c) {
        controller = c;
        c.enqueue(new TextEncoder().encode(`event: ${delta.type}\ndata: ${JSON.stringify(delta)}\n\n`));
      } }), { headers: { "content-type": "text/event-stream" } }),
    });
    const model = new OpenAIModel({ client, traceSink: store });
    await expect(model.respond({ model: "test", instructions: "fixture", input: "hello", tools: [], stream: true,
      onStreamEvent() { controller.error(new TypeError("terminated", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) })); },
    })).rejects.toThrow("terminated");
    await store.failTurn(session.id, "terminated");
    const contents = await readFile(store.filePath(session.id), "utf8");
    const entries = parseSessionEntries(contents);
    expect(entries.find((entry) => entry.type === "openai.stream")).toMatchObject({ event: delta });
    expect(entries.find((entry) => entry.type === "openai.error")).toMatchObject({ error: { message: "terminated", cause: { code: "UND_ERR_SOCKET" } } });
    expect(contents).not.toContain("fixture-key");
    const report = parseOpenAITraceJsonl(contents);
    expect(report.turns).toHaveLength(1);
    expect(report.totals.errors).toBe(1);
    expect(report.warnings).toEqual([]);
  });

  it("uses raw debug responses for display without duplicating canonical messages", async () => {
    const { directory } = await fixture();
    const store = new JsonlConversationStore(directory);
    const session = await store.create({ model: "test", title: "debug" });
    await store.beginTurn(session.id, "question");
    await store.recordAgentEvent({ type: "model_requested", step: 1, model: "test" });
    await store.log({ type: "openai.request", traceId: "wire-id", timestamp: new Date().toISOString(), endpoint: "https://example.test/v1/responses", body: { model: "test", input: "question", instructions: "original instructions" } });
    await store.log({ type: "openai.response", traceId: "wire-id", timestamp: new Date().toISOString(), requestId: null, durationMs: 10, http: { status: 200, statusText: "OK", headers: {} }, body: { id: "r1", output: [], output_text: "answer", status: "completed", usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } });
    await store.recordAgentEvent({ type: "model_response", step: 1, response: response("r1", "answer") });
    await store.appendTurn(session.id, { user: "question", assistant: "answer", responseId: "r1", createdAt: new Date().toISOString() });
    const report = parseOpenAITraceJsonl(await readFile(store.filePath(session.id), "utf8"));
    expect(report.turns).toHaveLength(1);
    expect(report.turns[0]?.rawRequest).toMatchObject({ traceId: "wire-id", body: { input: "question", instructions: "original instructions" } });
    expect(report.totals.totalTokens).toBe(8);
    expect((await store.load(session.id)).context).toHaveLength(2);
  });

  it("recovers a partially written final line and keeps appending valid JSONL", async () => {
    const { directory } = await fixture();
    const store = new JsonlConversationStore(directory);
    const session = await store.create({ model: "test", title: "tail" });
    await store.beginTurn(session.id, "unfinished");
    await appendFile(store.filePath(session.id), '{"type":"session.model_res');
    const reopened = new JsonlConversationStore(directory);
    expect((await reopened.load(session.id)).pendingTask).toBe("unfinished");
    await reopened.beginTurn(session.id, "continue");
    const contents = await readFile(reopened.filePath(session.id), "utf8");
    for (const line of contents.trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
    expect((await reopened.load(session.id)).pendingTask).toBe("continue");
  });

});
