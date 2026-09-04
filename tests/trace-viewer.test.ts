import { readFile, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultBrowserCommand } from "../src/cli/open-default-browser.js";
import { generateTraceReport } from "../src/trace-viewer/generate-report.js";
import { findLatestTraceFile } from "../src/trace-viewer/latest-trace.js";
import { parseOpenAITraceJsonl } from "../src/trace-viewer/parse-trace.js";
import { renderTraceReportHtml } from "../src/trace-viewer/render-html.js";
import { createRunCommandTool } from "../src/tools/run-command.js";
import { createTempDirectoryFixture } from "./test-utils.js";

const tools = [createRunCommandTool().definition];
const errorEntry = {
  type: "openai.error",
  timestamp: "2026-08-14T08:00:00.000Z",
  traceId: "trace-error",
  durationMs: 12,
  error: { name: "BadRequest", message: "invalid input", status: 400 },
};
const errorEntryJson = JSON.stringify(errorEntry);
const createTempDirectory = createTempDirectoryFixture();

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
              content: [{ type: "reasoning_text", text: "First inspect the source tree." }],
            },
            {
              type: "function_call",
              call_id: "call-1",
              name: "run_command",
              arguments: JSON.stringify({ command: "cat src/index.ts", cwd: ".", timeoutMs: 10_000 }),
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
              output: JSON.stringify({ ok: true, result: { output: "export const value = 42;", exitCode: 0 } }),
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
    expect(report.turns[0]?.reasoningTexts).toEqual(["First inspect the source tree."]);
    expect(report.turns[1]?.assistantMessages).toEqual(["Found the entry point."]);

    const html = renderTraceReportHtml(report);
    expect(html).toContain("用户输入");
    expect(html).toContain("run_command");
    expect(html).toContain("最终回答");
    expect(html).toContain("模型思考 / reasoning text");
    expect(html).toContain("First inspect the source tree.");
    expect(html).toContain("折叠 1 份重复 instructions");
    expect(html).toContain("Inspect &lt;src&gt;.");
    expect(html).not.toContain("Inspect <src>.");
  });

  it("keeps parsing valid lines after a malformed line", () => {
    const report = parseOpenAITraceJsonl(`{not-json}\n${errorEntryJson}`);

    expect(report.warnings).toHaveLength(1);
    expect(report.turns[0]?.error).toMatchObject({ name: "BadRequest", status: 400 });
    expect(report.totals.errors).toBe(1);
  });

  it("finds the newest JSONL log and generates a standalone HTML report", async () => {
    const root = await createTempDirectory("simple-code-agent-latest-trace-");
    const olderPath = path.join(root, "older.jsonl");
    const latestPath = path.join(root, "latest.jsonl");
    await writeFile(olderPath, errorEntryJson, "utf8");
    await writeFile(latestPath, errorEntryJson, "utf8");
    await utimes(olderPath, new Date(1_000), new Date(1_000));
    await utimes(latestPath, new Date(2_000), new Date(2_000));

    await expect(findLatestTraceFile(root)).resolves.toBe(latestPath);
    const generated = await generateTraceReport(latestPath);
    expect(generated.outputPath).toBe(path.join(root, "latest.html"));
    expect(await readFile(generated.outputPath, "utf8")).toContain("<!doctype html>");
  });

  it("uses a direct platform command to open the report", () => {
    expect(defaultBrowserCommand("C:\\trace.html", "win32")).toEqual({
      program: "explorer.exe",
      args: ["C:\\trace.html"],
    });
    expect(defaultBrowserCommand("/tmp/trace.html", "darwin").program).toBe("open");
    expect(defaultBrowserCommand("/tmp/trace.html", "linux").program).toBe("xdg-open");
  });
});
