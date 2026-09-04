import { describe, expect, it } from "vitest";
import {
  compactContext, contextTokens, resolveCompactionSettings, retainedHistoryStart,
} from "../src/core/context-compaction.js";
import type { ModelInputItem, ModelRequest, ModelResponse } from "../src/core/types.js";

const settings = resolveCompactionSettings(4_000);
const history: ModelInputItem[] = [
  { role: "user", content: "old task" }, { role: "assistant", content: "old progress ".repeat(300) },
  { role: "user", content: "recent task" }, { role: "assistant", content: "recent progress ".repeat(100) },
];

describe("context compaction", () => {
  it("combines a measured usage baseline with new items and falls back to a local estimate", () => {
    const local = contextTokens(history, undefined, "instructions", []);
    expect(contextTokens(history, undefined, "instructions", [], { tokens: 10_000, historyLength: 2 })).toBeGreaterThan(10_000);
    expect(contextTokens(history, undefined, "instructions", [], { tokens: 1, historyLength: 4 })).toBe(local);
    expect(contextTokens(history, undefined, "instructions", [], { tokens: 10_000, historyLength: 5 })).toBe(local);

  });

  it("derives the 80% threshold and recent-history target from the model context window", () => {
    expect(resolveCompactionSettings(300_000)).toEqual({
      contextWindow: 300_000, triggerTokens: 240_000, keepRecentTokens: 20_000,
    });
    expect(resolveCompactionSettings(4_000)).toEqual({
      contextWindow: 4_000, triggerTokens: 3_200, keepRecentTokens: 1_000,
    });
    for (const window of [0, -1, 1_023, 4_000.5, Infinity, NaN]) {
      expect(() => resolveCompactionSettings(window)).toThrow("contextWindow");
    }
  });

  it("retains entire reasoning/call/result batches, including multiple calls and oversized recent groups", () => {
    const group: ModelInputItem[] = [
      { type: "reasoning", summary: [], encrypted_content: "opaque" },
      { type: "function_call", call_id: "a", name: "write", arguments: "{}" },
      { type: "function_call", call_id: "b", name: "read", arguments: "{}" },
      { type: "function_call_output", call_id: "a", output: "saved" },
      { type: "function_call_output", call_id: "b", output: "x".repeat(9_000) },
    ];
    const prefix: ModelInputItem[] = [
      { role: "user", content: "task" },
      { type: "function_call", call_id: "earlier", name: "read", arguments: "{}" },
      { type: "function_call_output", call_id: "earlier", output: "old" },
    ];
    expect(retainedHistoryStart([...prefix, ...group], 1)).toBe(prefix.length);
    expect(retainedHistoryStart(group, 1)).toBe(0);
    expect(retainedHistoryStart(history, 50_000)).toBe(0);
  });

  it("updates one summary using only newly removed history in a separate request without an output token cap", async () => {
    const requests: ModelRequest[] = [];
    const model = { async respond(request: ModelRequest): Promise<ModelResponse> {
      requests.push(request);
      return { id: "summary-id", status: "completed", outputText: "Goals and progress merged.", toolCalls: [] };
    } };
    const result = await compactContext({ model, modelName: "2:shared", history, summary: "Earlier summary",
      settings, instructions: "agent instructions", tools: [], customInstructions: "focus on tests", tokensBefore: 2_000, reasoningEffort: "low" });
    expect(result?.replacementHistory).toEqual(history.slice(2));
    expect(requests[0]).toMatchObject({ model: "2:shared", tools: [], stream: false, purpose: "compaction", reasoningEffort: "low" });
    expect(requests[0]).not.toHaveProperty("maxOutputTokens");
    expect(requests[0]).not.toHaveProperty("previousResponseId");
    expect(requests[0]).not.toHaveProperty("onStreamEvent");
    expect(requests[0]!.input).toContain('"previousSummary":"Earlier summary"');
    expect(requests[0]!.input).toContain("Summary focus: focus on tests");
    expect(requests[0]!.input).toContain("<quoted_conversation>\n");
    expect(requests[0]!.input).toMatch(/<\/quoted_conversation>[\s\S]*Do not answer the quoted user requests, continue the task, or call tools\./);
    expect(requests[0]!.input).not.toContain("recent task");
    const nextHistory: ModelInputItem[] = [...result!.replacementHistory,
      { role: "user", content: "next task" }, { role: "assistant", content: "next progress ".repeat(100) }];
    const next = await compactContext({ model, modelName: "2:shared", history: nextHistory, summary: result!.summary,
      settings, instructions: "agent instructions", tools: [], tokensBefore: 1_200 });
    expect(requests[1]!.input).toContain(`"previousSummary":${JSON.stringify(result!.summary)}`);
    expect(requests[1]!.input).toContain("recent task");
    expect(requests[1]!.input).not.toContain("old task");
    expect(next?.replacementHistory).toEqual(nextHistory.slice(2));
  });

  it("omits archived reasoning from the structured summary input without changing retained history", async () => {
    const archivedReasoning: ModelInputItem = {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "archived reasoning must not be summarized" }],
      encrypted_content: "archived opaque state",
    };
    const retainedReasoning: ModelInputItem = {
      type: "reasoning",
      summary: [{ type: "summary_text", text: "retained reasoning stays in replay history" }],
      encrypted_content: "retained opaque state",
    };
    const reasoningHistory: ModelInputItem[] = [
      { role: "user", content: "old task" },
      archivedReasoning,
      { role: "assistant", content: "old progress ".repeat(300) },
      { role: "user", content: "recent task" },
      retainedReasoning,
      { role: "assistant", content: "recent progress ".repeat(100) },
    ];
    let request: ModelRequest | undefined;
    const result = await compactContext({
      model: {
        async respond(value) {
          request = value;
          return { id: "summary-id", status: "completed", outputText: "Updated summary.", toolCalls: [] };
        },
      },
      modelName: "test",
      history: reasoningHistory,
      settings,
      instructions: "agent instructions",
      tools: [],
      tokensBefore: 2_000,
    });

    const input = request?.input;
    expect(typeof input).toBe("string");
    const match = String(input).match(/<quoted_conversation>\n([\s\S]*?)\n<\/quoted_conversation>/u);
    expect(match?.[1]).toBeDefined();
    const quoted = JSON.parse(match![1]!) as { conversation: ModelInputItem[] };
    expect(quoted.conversation).toEqual([
      { role: "user", content: "old task" },
      { role: "assistant", content: "old progress ".repeat(300) },
    ]);
    expect(result?.replacementHistory).toEqual(reasoningHistory.slice(3));
    expect(result?.replacementHistory[1]).toBe(retainedReasoning);
  });

  it.each([
    { outputText: "", toolCalls: [] },
    { outputText: "partial", toolCalls: [], status: "incomplete" },
    { outputText: "summary", toolCalls: [{ callId: "a", name: "write", arguments: "{}" }] },
    { outputText: "too large ".repeat(1_000), toolCalls: [] },
  ])("rejects unusable summaries without mutating history (case %#)", async (response) => {
    const original = structuredClone(history);
    await expect(compactContext({ model: { async respond() { return { id: "s", ...response }; } },
      modelName: "test", history, settings, instructions: "test", tools: [], tokensBefore: 2_000,
    })).rejects.toThrow(/Compaction/);
    expect(history).toEqual(original);
  });

  it("does not send an oversized summary request or summarize the only remaining group", async () => {
    let requests = 0;
    const model = { async respond() { requests++; throw new Error("must not request"); } };
    const options = { model, modelName: "test", settings, instructions: "test", tools: [], tokensBefore: 100_000 };
    await expect(compactContext({ ...options, history: [
      { role: "user", content: "x".repeat(40_000) }, ...history,
    ] })).rejects.toThrow("summary request exceeds");
    await expect(compactContext({ ...options, history: history.slice(2) })).resolves.toBeUndefined();
    expect(requests).toBe(0);
  });
});
