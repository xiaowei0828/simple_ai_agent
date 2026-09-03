import process from "node:process";
import type { AgentEvent, AgentEventHandler } from "../core/types.js";

interface TextOutput {
  write(value: string): unknown;
}

export interface ConsoleEventLoggerOptions {
  stream: boolean;
  stdout?: TextOutput;
  stderr?: TextOutput;
}

export function createConsoleEventLogger(
  options: ConsoleEventLoggerOptions,
): AgentEventHandler {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  let outputStarted = false;
  let outputOpen = false;
  let reasoningStarted = false;
  let reasoningAtLineStart = true;

  const writeOutput = (delta: string): void => {
    if (!delta) return;
    if (!outputOpen) {
      stdout.write("assistant> ");
      outputOpen = true;
    }
    outputStarted = true;
    stdout.write(delta);
  };

  const closeOutput = (): void => {
    if (!outputOpen) return;
    stdout.write("\n\n");
    outputOpen = false;
  };

  const writeReasoning = (delta: string): void => {
    if (!delta) return;
    let output = "";
    for (const character of delta) {
      if (reasoningAtLineStart) {
        output += "thinking> ";
        reasoningAtLineStart = false;
      }
      output += character;
      if (character === "\n") reasoningAtLineStart = true;
    }
    reasoningStarted = true;
    stderr.write(output);
  };

  const closeReasoning = (): void => {
    if (reasoningStarted && !reasoningAtLineStart) stderr.write("\n");
    reasoningAtLineStart = true;
  };

  const resetModelStream = (): void => {
    outputStarted = false;
    outputOpen = false;
    reasoningStarted = false;
    reasoningAtLineStart = true;
  };

  return (event: AgentEvent): void => {
    switch (event.type) {
      case "run_started":
        stderr.write("agent: started\n");
        break;
      case "model_output_delta":
        if (options.stream) {
          closeReasoning();
          writeOutput(event.delta);
        }
        break;
      case "model_reasoning_delta":
        if (options.stream) writeReasoning(event.delta);
        break;
      case "model_response_failed":
        closeReasoning();
        closeOutput();
        resetModelStream();
        break;
      case "model_response":
        closeReasoning();
        closeOutput();
        stderr.write(
          `agent: model turn ${event.step}, ${event.response.toolCalls.length} tool call(s)\n`,
        );
        if (event.response.reasoningSummaryUnavailable) {
          stderr.write(
            "agent: reasoning summaries are unsupported by this model; continuing without them\n",
          );
        }
        const finalReasoning = event.response.reasoningSummary ?? event.response.reasoningText;
        if (finalReasoning && !reasoningStarted) {
          stderr.write(`${prefixLines("thinking> ", finalReasoning)}\n`);
        }
        if (options.stream && event.response.outputText && !outputStarted) {
          writeOutput(event.response.outputText);
          closeOutput();
        }
        resetModelStream();
        break;
      case "tool_requested":
        stderr.write(
          `agent: requesting ${event.call.name}${event.risk ? ` [${event.risk}]` : ""}\n`,
        );
        break;
      case "tool_completed":
        stderr.write(`agent: ${event.toolName} completed\n`);
        break;
      case "tool_failed":
        stderr.write(`agent: ${event.toolName} failed: ${event.error}\n`);
        break;
      default:
        break;
    }
  };
}

function prefixLines(prefix: string, value: string): string {
  return value.split(/\r?\n/u).map((line) => `${prefix}${line}`).join("\n");
}
