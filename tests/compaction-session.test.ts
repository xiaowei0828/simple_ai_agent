import { readFile } from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/core/context-compaction.js";
import type { AgentEvent, ModelAdapter, ModelRequest } from "../src/core/types.js";
import { runInteractiveSession } from "../src/cli/interactive-session.js";
import { JsonlConversationStore, parseSessionEntries, replayConversation } from "../src/history/session-store.js";
import { ConfiguredModel } from "../src/model/configured-model.js";
import { OpenAIModel } from "../src/model/openai-model.js";
import { AllowAllApprovalPolicy } from "../src/policy/approval-policy.js";
import { ToolRegistry } from "../src/tools/types.js";
import { parseOpenAITraceJsonl } from "../src/trace-viewer/parse-trace.js";
import { renderTraceReportHtml } from "../src/trace-viewer/render-html.js";
import { createTempDirectoryFixture, scriptedIO, createTestRunner } from "./test-utils.js";

const contextWindow = 4_000;
const createTempDirectory = createTempDirectoryFixture();
async function fixture() {
  const root = await createTempDirectory("agent-compaction-");
  const directory = path.join(root, ".agent-runs");
  const store = new JsonlConversationStore(directory);
  const session = await store.create({ model: "test", title: "compaction" });
  await store.appendTurn(session.id, { user: "old task", assistant: "old progress ".repeat(300), createdAt: new Date().toISOString() });
  return { root, directory, store, id: session.id };
}

const answer = (id: string, text = "done") => ({ id, outputText: text, toolCalls: [] });

describe("compacted sessions", () => {
  it.each([
    { model: "small", tokens: 3_199, compacted: false },
    { model: "small", tokens: 3_200, compacted: true },
    { model: "large", tokens: 3_200, compacted: false },
  ])("checks the selected model's 80% threshold ($model, $tokens tokens)", async ({ model, tokens, compacted }) => {
    const { root, store, id } = await fixture();
    const initial = await store.load(id);
    const requests: ModelRequest[] = [];
    const runner = createTestRunner({
      model: { async respond(request) {
        requests.push(request);
        return answer("response", request.purpose ? "Old work summary" : "done");
      } },
      modelName: "large", instructions: "fixture", toolContext: { workspaceRoot: root },
      approvalPolicy: new AllowAllApprovalPolicy(), contextWindow: (name) => name === "small" ? 4_000 : 8_000,
    });
    await runner.run("continue", { model, history: initial.context,
      contextUsage: { tokens: tokens - estimateTokens({ role: "user", content: "continue" }), historyLength: initial.context.length },
    });
    expect(requests.filter((request) => request.purpose === "compaction")).toHaveLength(compacted ? 1 : 0);
    expect(requests.every((request) => request.model === model)).toBe(true);
  });

  it.each(["before request", "after tools"])("automatically checkpoints %s and starts a new response chain without repeating tools", async (when) => {
    const { root, directory, store, id } = await fixture();
    const events: AgentEvent[] = [];
    const requests: ModelRequest[] = [];
    let executions = 0;
    let approvals = 0;
    let normalRequests = 0;
    const tools = new ToolRegistry([{
      definition: { type: "function", name: "write", description: "fixture", parameters: {}, strict: false },
      risk: "write", parse: (input) => input,
      async execute() { executions++; return "saved ".repeat(150); },
    }]);
    if (when === "before request") {
      await store.beginTurn(id, "previous");
      await store.recordAgentEvent({ type: "model_response", step: 1, response: {
        ...answer("old-id", "previous answer"), usage: { total_tokens: 3_500 },
      } });
      await store.appendTurn(id, { user: "previous", assistant: "previous answer", createdAt: new Date().toISOString() });
    }
    const model: ModelAdapter = { async respond(request) {
      requests.push(request);
      if (request.purpose === "compaction") return answer("summary-only-id", "Old task and progress.");
      normalRequests++;
      if (request.previousResponseId === undefined && (when === "before request" || normalRequests > 1)) {
        const saved = await new JsonlConversationStore(directory).load(id);
        expect(saved.summary).toBe("Old task and progress.");
        expect(saved.contextUsage).toBeUndefined();
        expect(saved.pendingTask).toBe("current task");
        expect(request.input).toEqual([
          { role: "user", content: expect.stringContaining(saved.summary!) }, ...replayConversation(saved),
        ]);
      }
      if (normalRequests <= 2) return {
        id: `normal-${normalRequests}`, outputText: "", toolCalls: [{ callId: `call-${normalRequests}`, name: "write", arguments: "{}" }],
        outputItems: [
          { type: "reasoning", summary: [], encrypted_content: `opaque-${normalRequests}` },
          { type: "function_call", call_id: `call-${normalRequests}`, name: "write", arguments: "{}" },
        ],
        ...(when === "after tools" && normalRequests === 1 ? { usage: { total_tokens: 3_500 } } : {}),
      };
      return answer("final-id");
    } };
    const runner = createTestRunner({ model, modelName: "test", instructions: "fixture", tools, toolContext: { workspaceRoot: root },
      approvalPolicy: { async approve() { approvals++; return true; } }, contextWindow: () => contextWindow,
      onEvent: async (event) => { events.push(event); await store.recordAgentEvent(event); },
    });
    const initial = await store.load(id);
    await store.beginTurn(id, "current task");
    const result = await runner.run("current task", { previousResponseId: "live-old-id", history: initial.context, contextUsage: initial.contextUsage });
    await store.appendTurn(id, { user: "current task", assistant: result.output, responseId: result.responseId, createdAt: new Date().toISOString() });
    expect(result).toEqual({ output: "done", steps: 3, responseId: "final-id" });
    expect(executions).toBe(2);
    expect(approvals).toBe(2);
    expect(events.filter((event) => event.type === "compaction_completed")).toHaveLength(1);
    const responseEvents = events.filter((event) => event.type === "model_response");
    expect(responseEvents).toHaveLength(3);
    for (const event of responseEvents) {
      expect(event.context).toMatchObject({ contextWindow, triggerTokens: 3_200 });
    }
    if (when === "after tools") expect(responseEvents[0]?.context?.tokens).toBe(3_500);
    // The pre-compaction usage baseline must not leak into the new context's status.
    expect(responseEvents[1]!.context!.tokens).toBeLessThan(3_200);
    expect(responseEvents[2]!.context!.tokens).toBeGreaterThan(responseEvents[1]!.context!.tokens);
    expect(requests.filter((request) => request.purpose === "compaction")).toHaveLength(1);
    expect(requests.at(-1)?.previousResponseId).toBe("normal-2");
    expect(requests.at(-1)?.input).toEqual([{ type: "function_call_output", call_id: "call-2", output: expect.any(String) }]);
    const after = await new JsonlConversationStore(directory).load(id);
    expect(after.status).toBe("idle");
    expect(after.turns.at(-1)?.user).toBe("current task");
    expect(after.context.filter((item) => "type" in item && item.type === "function_call_output")).toHaveLength(2);
    const report = parseOpenAITraceJsonl(await readFile(store.filePath(id), "utf8"));
    expect(report.turns.filter((turn) => turn.purpose === "compaction")).toHaveLength(1);
    expect(report.totals.toolCalls).toBe(2);
    expect(report.totals.errors).toBe(0);
  });

  it("manual compression and repeated resumes replace active context while retaining the complete transcript", async () => {
    const { root, directory, store, id } = await fixture();
    await store.appendTurn(id, { user: "recent task", assistant: "recent progress ".repeat(100), createdAt: new Date().toISOString() });
    const requests: ModelRequest[] = [];
    const outputs: string[] = [];
    let summaries = 0;
    for (let cycle = 1; cycle <= 2; cycle++) {
      const reopened = new JsonlConversationStore(directory);
      const runner = createTestRunner({
        model: { async respond(request) {
          requests.push(request);
          if (request.purpose) return answer("summary-id", `Merged summary ${++summaries}`);
          return answer(`live-${cycle}`, "current progress ".repeat(100));
        } }, modelName: "test", instructions: "fixture", toolContext: { workspaceRoot: root },
        approvalPolicy: new AllowAllApprovalPolicy(), contextWindow: () => contextWindow, onEvent: (event) => reopened.recordAgentEvent(event),
      });
      await runInteractiveSession({ agent: runner, initialModel: "test", historyStore: reopened,
        io: scriptedIO([id, "/compact focus on pending changes", `continue ${cycle}`, "/exit"], { assistant: outputs }) });
      const loaded = await reopened.load(id);
      expect(loaded.summary).toBe(`Merged summary ${cycle}`);
      expect(loaded.turns).toHaveLength(2 + cycle);
      expect(loaded.context.filter((item) => "role" in item && item.role === "user")).toHaveLength(2);
      expect(JSON.stringify(loaded.context)).not.toContain("old task");
    }
    expect(summaries).toBe(2);
    expect(outputs).toHaveLength(2);
    expect(requests[1]?.previousResponseId).toBeUndefined();
    expect(requests[3]?.previousResponseId).toBeUndefined();
    const secondSummaryInput = requests[2]!.input;
    expect(secondSummaryInput).toContain('"previousSummary":"Merged summary 1"');
    expect(secondSummaryInput).toContain("Summary focus: focus on pending changes");
    expect(secondSummaryInput).not.toContain("old task");
    const raw = await readFile(store.filePath(id), "utf8");
    expect(raw).toContain("old task");
    const entries = parseSessionEntries(raw);
    expect(entries.filter((entry) => entry.type === "session.compacted")).toHaveLength(2);
    expect(entries.filter((entry) => entry.type === "session.turn_started")).toHaveLength(2);
    expect(entries.filter((entry) => entry.type === "session.model_response")).toHaveLength(2);
  });

  it.each(["summary fails", "summary returns tools", "checkpoint fails", "request after checkpoint fails"])("recovers durable context when %s", async (failure) => {
    const { root, directory, store, id } = await fixture();
    const initial = await store.load(id);
    let normalRequests = 0;
    const runner = createTestRunner({ model: { async respond(request) {
      if (request.purpose) {
        if (failure === "summary fails") throw new Error("summary offline");
        if (failure === "summary returns tools") return {
          id: "summary-id", status: "completed", outputText: "", toolCalls: [
            { callId: "a", name: "run_command", arguments: "{}" },
            { callId: "b", name: "run_command", arguments: "{}" },
          ],
        };
        return answer("summary-id", "Saved progress");
      }
      normalRequests++;
      throw new Error("task offline");
    } }, modelName: "test", instructions: "fixture", toolContext: { workspaceRoot: root },
      approvalPolicy: new AllowAllApprovalPolicy(), contextWindow: () => contextWindow, onEvent: async (event) => {
        if (failure === "checkpoint fails" && event.type === "compaction_completed") throw new Error("disk full");
        await store.recordAgentEvent(event);
      },
    });
    await store.beginTurn(id, "continue");
    await expect(runner.run("continue", { history: initial.context, contextUsage: { tokens: 3_500, historyLength: initial.context.length } }))
      .rejects.toThrow(/offline|disk full|tool calls instead of a summary: run_command, run_command/);
    const loaded = await new JsonlConversationStore(directory).load(id);
    expect(loaded.status).toBe("running");
    expect(loaded.pendingTask).toBe("continue");
    expect(loaded.turns).toHaveLength(1);
    if (failure === "request after checkpoint fails") {
      expect(normalRequests).toBe(1);
      expect(loaded.summary).toBe("Saved progress");
      expect(loaded.context).toEqual([{ role: "user", content: "continue" }]);
    } else {
      expect(normalRequests).toBe(0);
      expect(loaded.summary).toBeUndefined();
      expect(loaded.context).toEqual([...initial.context, { role: "user", content: "continue" }]);
    }
    const report = parseOpenAITraceJsonl(await readFile(store.filePath(id), "utf8"));
    expect(report.totals.errors).toBe(failure === "request after checkpoint fails" ? 0 : 1);
  });

  it.each([false, true])("rebuilds a live continuation after manual compaction (failed=%s)", async (failed) => {
    const { root, store, id } = await fixture();
    const requests: ModelRequest[] = [];
    const outputs: string[] = [];
    const statuses: string[] = [];
    const runner = createTestRunner({ model: { async respond(request) {
      requests.push(request);
      if (request.purpose) {
        if (failed) throw new Error("summary offline");
        return answer("summary-id", "Old work summary");
      }
      return answer("live-id", "recent progress ".repeat(100));
    } }, modelName: "test", instructions: "fixture", toolContext: { workspaceRoot: root },
      approvalPolicy: new AllowAllApprovalPolicy(), contextWindow: () => contextWindow,
      onEvent: (event) => store.recordAgentEvent(event),
    });
    await runInteractiveSession({ agent: runner, initialModel: "test", historyStore: store,
      io: scriptedIO([id, "live task", "/compact", "follow up", "/exit"], { assistant: outputs, status: statuses }) });
    expect(requests).toHaveLength(3);
    expect(requests[2]?.previousResponseId).toBeUndefined();
    expect(outputs).toHaveLength(2);
    expect(JSON.stringify(requests[2]?.input)).toContain("live task");
    expect(JSON.stringify(requests[2]?.input).includes("old task")).toBe(failed);
    expect(statuses.some((message) => message.includes("Compaction failed"))).toBe(failed);
    const saved = await store.load(id);
    expect(saved.turns).toHaveLength(3);
    expect(saved.status).toBe("idle");
    expect(saved.summary).toBe(failed ? undefined : "Old work summary");
  });

  it.each(["length", "max_output_tokens"])("reports truncated summaries (%s) with usage and retains the original checkpoint state", async (reason) => {
    const { root, store, id } = await fixture();
    await store.appendTurn(id, { user: "recent task", assistant: "recent progress ".repeat(100), createdAt: new Date().toISOString() });
    const initial = await store.load(id);
    let requests = 0;
    const runner = createTestRunner({
      model: new OpenAIModel({ client: new OpenAI({ apiKey: "fixture-key", baseURL: "https://fixture.test/v1", maxRetries: 0,
        fetch: async (_input, init) => {
          requests++;
          const body = JSON.parse(String(init?.body));
          expect(body).toMatchObject({ reasoning: { effort: "high" }, tool_choice: "none" });
          expect(body).not.toHaveProperty("max_output_tokens");
          return new Response(JSON.stringify({ id: "incomplete-summary", status: "incomplete", incomplete_details: { reason },
            output: [{ type: "message", role: "assistant", status: "incomplete", content: [{ type: "output_text", text: "Goal: explain the timer. Next steps: read", annotations: [] }] }],
            usage: { input_tokens: 38_741, output_tokens: 4_096, total_tokens: 42_837, output_tokens_details: { reasoning_tokens: 2_882 } },
          }), { headers: { "content-type": "application/json" } });
        },
      }) }), modelName: "test", instructions: "fixture", toolContext: { workspaceRoot: root },
      approvalPolicy: new AllowAllApprovalPolicy(), contextWindow: () => contextWindow, reasoningEffort: "high",
      onEvent: (event) => store.recordAgentEvent(event),
    });
    store.beginCompaction(id);
    try {
      await expect(runner.compact({ history: initial.context })).rejects.toThrow(
        `Compaction hit the output token limit; the summary is incomplete (status=incomplete, reason=${reason}, output_tokens=4096, reasoning_tokens=2882). Original history was preserved.`,
      );
    } finally {
      store.endCompaction();
    }
    expect(requests).toBe(1);
    const saved = await store.load(id);
    expect(saved.context).toEqual(initial.context);
    expect(saved.summary).toBeUndefined();
    expect(saved.status).toBe("idle");
    expect(saved.turns).toHaveLength(2);
    const raw = await readFile(store.filePath(id), "utf8");
    const entries = parseSessionEntries(raw);
    expect(entries.some((entry) => entry.type === "session.compacted")).toBe(false);
    expect(entries.find((entry) => entry.type === "session.compaction_failed")?.error).toContain(`reason=${reason}`);
    expect(renderTraceReportHtml(parseOpenAITraceJsonl(raw))).toContain("reasoning_tokens=2882");
  });

  it("sends a dedicated summary API request on the selected connection and gives debug traces a separate row", async () => {
    const { root, store, id } = await fixture();
    const sent: Array<{ body: Record<string, unknown>; url: string; authorization: string | null }> = [];
    const model = new ConfiguredModel({ defaults: { reasoningEffort: "low" },
      connections: [{ apiKey: "fixture-key", baseUrl: "https://selected.test/v1", models: [{ id: "test" }] }] },
      (config) => new OpenAIModel({ traceSink: store, client: new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl, maxRetries: 0,
        fetch: async (url, init) => {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          sent.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization"), body });
          return new Response(JSON.stringify({ id: `response-${sent.length}`, object: "response", status: "completed",
            output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: body.store ? "Task answer" : "Checkpoint summary", annotations: [] }] }],
          }), { headers: { "content-type": "application/json" } });
        },
      }) }));
    const runner = createTestRunner({ model, modelName: "test", instructions: "agent instructions",
      toolContext: { workspaceRoot: root }, approvalPolicy: new AllowAllApprovalPolicy(), contextWindow: () => contextWindow,
      stream: false, onEvent: (event) => store.recordAgentEvent(event),
    });
    const initial = await store.load(id);
    await store.beginTurn(id, "continue");
    const result = await runner.run("continue", { history: initial.context, previousResponseId: "old-live-id", reasoningEffort: "high",
      contextUsage: { tokens: 3_500, historyLength: initial.context.length } });
    await store.appendTurn(id, { user: "continue", assistant: result.output, responseId: result.responseId, createdAt: new Date().toISOString() });
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ url: "https://selected.test/v1/responses", authorization: "Bearer fixture-key",
      body: { model: "test", store: false, tools: [], tool_choice: "none", parallel_tool_calls: false } });
    expect(sent[0]!.body).not.toHaveProperty("max_output_tokens");
    expect(sent[0]!.body.stream).not.toBe(true);
    expect(sent[0]!.body).not.toHaveProperty("previous_response_id");
    expect(sent[0]!.body.reasoning).toEqual({ effort: "high" });
    expect(sent[1]!.body).toMatchObject({ store: true, parallel_tool_calls: true, reasoning: { summary: "auto", effort: "high" }, instructions: "agent instructions" });
    expect(sent[1]!.body).not.toHaveProperty("tool_choice");
    expect(sent[1]!.body).not.toHaveProperty("previous_response_id");
    const raw = await readFile(store.filePath(id), "utf8");
    const report = parseOpenAITraceJsonl(raw);
    expect(report.turns).toHaveLength(3); // Imported old answer, summary, current task.
    expect(report.turns.filter((turn) => turn.purpose === "compaction")).toHaveLength(1);
    expect(report.turns.find((turn) => turn.purpose === "compaction")?.configChanges).toEqual([]);
    expect(report.totals.errors).toBe(0);
    expect(renderTraceReportHtml(report)).toContain("压缩摘要");
    expect(raw).not.toContain("fixture-key");
    expect(parseSessionEntries(raw).filter((entry) => entry.type === "openai.request" && entry.purpose === "compaction")).toHaveLength(1);
  });
});
