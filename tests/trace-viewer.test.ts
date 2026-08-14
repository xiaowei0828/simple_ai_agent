import { describe, expect, it } from "vitest";
import { parseOpenAITraceJsonl } from "../src/trace-viewer/parse-trace.js";
import { renderTraceReportHtml } from "../src/trace-viewer/render-html.js";

const tools = [
  {
    type: "function",
    name: "read_file",
    description: "Read one file.",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  },
];

describe("trace viewer", () => {
  it("normalizes repeated request fields and pairs tool results with calls", () => {
    const entries = [
      {
        type: "openai.request",
        timestamp: "2026-08-14T08:00:00.000Z",
        traceId: "trace-1",
        endpoint: "https://example.test/v1/responses",
        body: { model: "model-a", instructions: "Be useful.", input: "Inspect <src>.", tools },
      },
      {
        type: "openai.response",
        timestamp: "2026-08-14T08:00:01.000Z",
        traceId: "trace-1",
        requestId: "request-1",
        durationMs: 1000,
        http: { status: 200 },
        body: {
          id: "response-1",
          model: "model-a-revision",
          status: "completed",
          output: [
            {
              type: "reasoning",
              summary: [{ type: "summary_text", text: "I should read the file." }],
            },
            {
              type: "function_call",
              call_id: "call-1",
              name: "read_file",
              arguments: JSON.stringify({ path: "src/index.ts" }),
            },
          ],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            total_tokens: 120,
            input_tokens_details: { cached_tokens: 50 },
          },
        },
      },
      {
        type: "openai.request",
        timestamp: "2026-08-14T08:00:01.100Z",
        traceId: "trace-2",
        endpoint: "https://example.test/v1/responses",
        body: {
          model: "model-a",
          instructions: "Be useful.",
          tools,
          previous_response_id: "response-1",
          input: [
            {
              type: "function_call_output",
              call_id: "call-1",
              output: JSON.stringify({ ok: true, result: { content: "export const value = 42;" } }),
            },
          ],
        },
      },
      {
        type: "openai.response",
        timestamp: "2026-08-14T08:00:02.100Z",
        traceId: "trace-2",
        durationMs: 1000,
        http: { status: 200 },
        body: {
          id: "response-2",
          model: "model-a-revision",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Found the entry point." }],
            },
          ],
          usage: { input_tokens: 120, output_tokens: 15, total_tokens: 135 },
        },
      },
    ];

    const report = parseOpenAITraceJsonl(entries.map((entry) => JSON.stringify(entry)).join("\n"), "run.jsonl");

    expect(report.turns).toHaveLength(2);
    expect(report.instructionVariants).toBe(1);
    expect(report.toolDefinitionVariants).toBe(1);
    expect(report.totals).toMatchObject({ toolCalls: 1, totalTokens: 255, cachedTokens: 50 });
    expect(report.turns[0]?.toolCalls[0]?.result).toMatchObject({ ok: true, returnedInTurn: 2 });
    expect(report.turns[1]?.assistantMessages).toEqual(["Found the entry point."]);

    const html = renderTraceReportHtml(report);
    expect(html).toContain("用户输入");
    expect(html).toContain("read_file");
    expect(html).toContain("最终回答");
    expect(html).toContain("折叠 1 份重复 instructions");
    expect(html).toContain("Inspect &lt;src&gt;.");
    expect(html).not.toContain("Inspect <src>.");
  });

  it("keeps parsing valid lines after a malformed line", () => {
    const report = parseOpenAITraceJsonl(
      `{not-json}\n${JSON.stringify({
        type: "openai.error",
        timestamp: "2026-08-14T08:00:00.000Z",
        traceId: "trace-error",
        durationMs: 12,
        error: { name: "BadRequest", message: "invalid input", status: 400 },
      })}`,
    );

    expect(report.warnings).toHaveLength(1);
    expect(report.turns[0]?.error).toMatchObject({ name: "BadRequest", status: 400 });
    expect(report.totals.errors).toBe(1);
  });
});
