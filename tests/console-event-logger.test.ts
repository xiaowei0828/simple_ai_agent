import { describe, expect, it } from "vitest";
import { createConsoleEventLogger } from "../src/cli/console-event-logger.js";

function captureOutput() {
  const chunks: string[] = [];
  return {
    output: {
      write(value: string) {
        chunks.push(value);
      },
    },
    text() {
      return chunks.join("");
    },
  };
}

describe("createConsoleEventLogger", () => {
  it.each([false, true])("prints context usage beside model turns (stream=%s)", async (stream) => {
    const stdout = captureOutput();
    const stderr = captureOutput();
    const log = createConsoleEventLogger({ stream, stdout: stdout.output, stderr: stderr.output });

    await log({
      type: "model_response", step: 3,
      response: { id: "response-3", outputText: "", toolCalls: [] },
      context: { tokens: 12_345, contextWindow: 300_000, triggerTokens: 240_000 },
    });

    expect(stderr.text()).toBe(
      "agent: model turn 3, 0 tool call(s), context ~12,345/300,000 tokens (4.1%), compact at 240,000\n",
    );
    expect(stdout.text()).toBe("");
  });

  it("reports an unknown window without inventing a percentage or threshold", async () => {
    const stderr = captureOutput();
    const log = createConsoleEventLogger({ stream: false, stderr: stderr.output });

    await log({
      type: "model_response", step: 1,
      response: { id: "response-1", outputText: "", toolCalls: [] },
      context: { tokens: 123 },
    });

    expect(stderr.text()).toBe(
      "agent: model turn 1, 0 tool call(s), context ~123 tokens (window unknown; auto-compaction disabled)\n",
    );
  });

  it("shows over-budget usage without clamping the percentage", async () => {
    const stderr = captureOutput();
    const log = createConsoleEventLogger({ stream: false, stderr: stderr.output });

    await log({
      type: "model_response", step: 2,
      response: { id: "response-2", outputText: "", toolCalls: [] },
      context: { tokens: 11_000, contextWindow: 10_000 },
    });

    expect(stderr.text()).toContain("context ~11,000/10,000 tokens (110.0%)\n");
  });

  it("prints streamed deltas once and preserves reasoning line prefixes", async () => {
    const stdout = captureOutput();
    const stderr = captureOutput();
    const log = createConsoleEventLogger({
      stream: true,
      stdout: stdout.output,
      stderr: stderr.output,
    });

    await log({ type: "model_reasoning_delta", step: 1, delta: "Inspect\nthen answer" });
    await log({ type: "model_output_delta", step: 1, delta: "hel" });
    await log({ type: "model_output_delta", step: 1, delta: "lo" });
    await log({
      type: "model_response",
      step: 1,
      response: {
        id: "response-1",
        outputText: "hello",
        reasoningSummary: "Inspect\nthen answer",
        toolCalls: [],
      },
      context: { tokens: 100, contextWindow: 10_000, triggerTokens: 8_000 },
    });

    expect(stdout.text()).toBe("assistant> hello\n\n");
    expect(stderr.text()).toBe(
      "thinking> Inspect\nthinking> then answer\nagent: model turn 1, 0 tool call(s), context ~100/10,000 tokens (1.0%), compact at 8,000\n",
    );
  });

  it("prints the final response when a compatible stream emits no text deltas", async () => {
    const stdout = captureOutput();
    const stderr = captureOutput();
    const log = createConsoleEventLogger({
      stream: true,
      stdout: stdout.output,
      stderr: stderr.output,
    });

    await log({
      type: "model_response",
      step: 1,
      response: {
        id: "response-1",
        outputText: "fallback output",
        reasoningText: "Raw reasoning text.",
        toolCalls: [],
      },
    });

    expect(stdout.text()).toBe("assistant> fallback output\n\n");
    expect(stderr.text()).toContain("thinking> Raw reasoning text.\n");
  });
});
