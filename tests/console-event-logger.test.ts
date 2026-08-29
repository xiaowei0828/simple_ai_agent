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
  it("prints streamed deltas once and preserves reasoning line prefixes", async () => {
    const stdout = captureOutput();
    const stderr = captureOutput();
    const log = createConsoleEventLogger({
      stream: true,
      interactive: true,
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
    });

    expect(stdout.text()).toBe("assistant> hello\n\n");
    expect(stderr.text()).toBe(
      "thinking> Inspect\nthinking> then answer\nagent: model turn 1, 0 tool call(s)\n",
    );
  });

  it("prints the final response when a compatible stream emits no text deltas", async () => {
    const stdout = captureOutput();
    const stderr = captureOutput();
    const log = createConsoleEventLogger({
      stream: true,
      interactive: false,
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

    expect(stdout.text()).toBe("fallback output\n");
    expect(stderr.text()).toContain("thinking> Raw reasoning text.\n");
  });
});
