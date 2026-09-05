import type { ModelResponse } from "../core/types.js";
import { responseInputItems } from "../core/context-compaction.js";

export interface ParsedTraceEntry {
  lineNumber: number;
  value: Record<string, unknown>;
}

/** Project durable session events into the viewer's existing request/response shape. */
export function projectSessionTrace(entries: ParsedTraceEntry[]): ParsedTraceEntry[] {
  if (!entries.some((entry) => entry.value.type === "session.created")) {
    return entries.filter((entry) => entry.value.type !== "openai.stream");
  }
  interface Step {
    request: ParsedTraceEntry;
    response?: ParsedTraceEntry;
    error?: ParsedTraceEntry;
    outputs: ParsedTraceEntry[];
    rawResponse: boolean;
  }
  const steps = new Map<string, Step>();
  const tasks = new Map<string, string>();
  let model: unknown;
  let reasoningEffort: unknown;
  let currentTurn = "";
  const stepFor = (entry: ParsedTraceEntry): Step => {
    const value = entry.value;
    const turnId = String(value.turnId ?? currentTurn);
    const stepNumber = Number(value.step) || 1;
    const compacting = value.purpose === "compaction" || value.type === "session.compacted"
      || String(value.type).startsWith("session.compaction_");
    const traceId = `${turnId}:${compacting ? "compaction:" : ""}${stepNumber}`;
    let step = steps.get(traceId);
    if (!step) {
      step = {
        request: { lineNumber: entry.lineNumber, value: {
          type: "openai.request", traceId, timestamp: value.timestamp,
          ...(compacting ? { purpose: "compaction" } : {}),
          body: { model, ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}), input: compacting ? "Summarize older context; retain recent messages." : stepNumber === 1 ? tasks.get(turnId) ?? "" : [] },
        } },
        outputs: [], rawResponse: false,
      };
      steps.set(traceId, step);
    }
    return step;
  };
  for (const entry of entries) {
    const value = entry.value;
    const type = value.type;
    if (type === "session.created") { model = value.model; reasoningEffort = value.reasoningEffort; continue; }
    if (type === "session.reasoning_effort_changed") { reasoningEffort = value.reasoningEffort; continue; }
    if (type === "session.turn_started") {
      currentTurn = String(value.turnId);
      tasks.set(currentTurn, String(value.task));
      continue;
    }
    if (type === "session.renamed" || type === "openai.stream") continue;
    if (type === "session.turn_failed") {
      const turnId = String(value.turnId ?? currentTurn);
      const stepNumber = Number(value.step) || 1;
      if (!steps.has(`${turnId}:${stepNumber}`) && steps.get(`${turnId}:compaction:${stepNumber}`)?.error) continue;
    }
    if (type === "session.turn_completed") {
      const turn = value.turn as { user: string; assistant: string; responseId?: string };
      const turnId = String(value.turnId ?? `imported-${entry.lineNumber}`);
      if ([...steps.keys()].some((key) => key.startsWith(`${turnId}:`))) continue;
      tasks.set(turnId, turn.user);
      const synthetic = { ...entry, value: { ...value, turnId, step: 1 } };
      const step = stepFor(synthetic);
      step.response = { ...entry, value: {
        type: "openai.response", traceId: step.request.value.traceId, timestamp: value.timestamp,
        body: { id: turn.responseId, model, status: "completed", output_text: turn.assistant, output: [] },
      } };
      continue;
    }
    const step = stepFor(entry);
    const traceId = step.request.value.traceId;
    if (type === "openai.request") {
      // Keep each original wire record on disk; use one viewer row per model step.
      const input = step.request.value.sessionInput ?? (step.request.value.body as Record<string, unknown>).input;
      step.request = { ...entry, value: { ...value, traceId, originalEntry: value, sessionInput: input } };
    } else if (type === "openai.response") {
      step.response = { ...entry, value: { ...value, traceId, originalEntry: value } };
      step.rawResponse = true;
      step.error = undefined;
    } else if (type === "openai.error") {
      step.error = { ...entry, value: { ...value, traceId, originalEntry: value } };
    } else if (type === "session.compacted" && !step.rawResponse) {
      step.response = { ...entry, value: {
        type: "openai.response", traceId, timestamp: value.timestamp, purpose: "compaction",
        body: { model, status: "completed", output: [], output_text: value.summary, usage: value.usage },
      } };
      step.error = undefined;
    } else if (type === "session.model_response" && !step.rawResponse) {
      const response = value.response as ModelResponse;
      step.response = { ...entry, value: {
        type: "openai.response", traceId, timestamp: value.timestamp,
        durationMs: Math.max(0, Date.parse(String(value.timestamp)) - Date.parse(String(step.request.value.timestamp))),
        body: { id: response.id, model, status: response.status ?? "completed", output: responseInputItems(response), output_text: response.outputText, usage: response.usage },
      } };
      step.error = undefined;
    } else if (type === "session.tool_output") {
      step.outputs.push({ ...entry, value: { ...value, traceId } });
    } else if ((type === "session.turn_failed" || type === "session.compaction_failed") && !step.error) {
      step.error = { ...entry, value: {
        type: "openai.error", traceId, timestamp: value.timestamp,
        error: { name: "Error", message: value.error },
      } };
    }
  }
  return [...steps.values()].flatMap((step) => [
    step.request, ...(step.response ? [step.response] : []),
    ...step.outputs, ...(step.error ? [step.error] : []),
  ]);
}
