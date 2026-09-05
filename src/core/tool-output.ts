export const MIN_TRUNCATED_TOOL_OUTPUT_CHARS = JSON.stringify({
  ok: false,
  truncated: true,
}).length;
const TRUNCATION_MARKER = "…[truncated]…";
const MIN_STRUCTURED_STRING_CHARS = 64;
const TRUNCATION_SEARCH_STEPS = 1_000;

export type ToolOutputValue =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

interface JsonLimits {
  maxStringChars: number;
  maxArrayItems: number;
}

interface JsonTruncationCounts {
  truncatedStrings: number;
  omittedStringChars: number;
  truncatedArrays: number;
  omittedArrayItems: number;
}

function previewHeadAndTail(value: string, retainedChars: number): string {
  const headChars = Math.ceil(retainedChars / 2);
  const tailChars = Math.floor(retainedChars / 2);
  const head = value.slice(0, headChars);
  const tail = tailChars > 0 ? value.slice(value.length - tailChars) : "";
  return `${head}${TRUNCATION_MARKER}${tail}`;
}

function serializeTruncatedToolOutput(
  value: ToolOutputValue,
  originalOutputChars: number,
  maxChars: number,
): string {
  const payload = value.ok
    ? (JSON.stringify(value.result) ?? "null")
    : value.error;
  let lowerBound = 0;
  let upperBound = Math.min(payload.length, maxChars);
  let bestOutput: string | undefined;

  while (lowerBound <= upperBound) {
    const retainedChars = Math.floor((lowerBound + upperBound) / 2);
    const preview = previewHeadAndTail(payload, retainedChars);
    const omittedPayloadChars = payload.length - retainedChars;
    const truncatedValue = value.ok
      ? {
          ok: true,
          result: preview,
          truncated: true,
          originalOutputChars,
          omittedResultChars: omittedPayloadChars,
        }
      : {
          ok: false,
          error: preview,
          truncated: true,
          originalOutputChars,
          omittedErrorChars: omittedPayloadChars,
        };
    const output = JSON.stringify(truncatedValue);
    if (output.length <= maxChars) {
      bestOutput = output;
      lowerBound = retainedChars + 1;
    } else {
      upperBound = retainedChars - 1;
    }
  }

  if (bestOutput) return bestOutput;
  for (const truncatedValue of [
    { ok: value.ok, truncated: true, originalOutputChars },
    { ok: value.ok, truncated: true },
  ]) {
    const output = JSON.stringify(truncatedValue);
    if (output.length <= maxChars) return output;
  }
  throw new Error("The tool output budget is too small to preserve status and truncation metadata.");
}

function measureJson(value: JsonValue, limits: JsonLimits): void {
  if (typeof value === "string") {
    limits.maxStringChars = Math.max(limits.maxStringChars, value.length);
    return;
  }
  if (Array.isArray(value)) {
    limits.maxArrayItems = Math.max(limits.maxArrayItems, value.length);
    for (const item of value) measureJson(item, limits);
    return;
  }
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) measureJson(child, limits);
  }
}

function previewWithinLimit(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= TRUNCATION_MARKER.length) {
    return TRUNCATION_MARKER.slice(0, maxChars);
  }
  return previewHeadAndTail(value, maxChars - TRUNCATION_MARKER.length);
}

function truncateJson(
  value: JsonValue,
  stringLimit: number,
  arrayLimit: number,
  counts: JsonTruncationCounts,
): JsonValue {
  if (typeof value === "string") {
    if (value.length <= stringLimit) return value;
    counts.truncatedStrings += 1;
    counts.omittedStringChars += value.length - stringLimit;
    return previewWithinLimit(value, stringLimit);
  }
  if (Array.isArray(value)) {
    const retainedItems = Math.min(value.length, arrayLimit);
    if (retainedItems < value.length) {
      counts.truncatedArrays += 1;
      counts.omittedArrayItems += value.length - retainedItems;
    }
    return value.slice(0, retainedItems).map((item) => (
      truncateJson(item, stringLimit, arrayLimit, counts)
    ));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      truncateJson(child, stringLimit, arrayLimit, counts),
    ]));
  }
  return value;
}

function serializeStructuredTruncatedSuccess(
  result: unknown,
  originalOutputChars: number,
  maxChars: number,
): string | undefined {
  const serializedResult = JSON.stringify(result) ?? "null";
  const jsonResult = JSON.parse(serializedResult) as JsonValue;
  const limits: JsonLimits = { maxStringChars: 0, maxArrayItems: 0 };
  measureJson(jsonResult, limits);
  let lowerBound = 0;
  let upperBound = TRUNCATION_SEARCH_STEPS;
  let bestOutput: string | undefined;

  while (lowerBound <= upperBound) {
    const step = Math.floor((lowerBound + upperBound) / 2);
    const ratio = step / TRUNCATION_SEARCH_STEPS;
    const minimumStringLimit = Math.min(
      MIN_STRUCTURED_STRING_CHARS,
      limits.maxStringChars,
    );
    const stringLimit = minimumStringLimit + Math.floor(
      (limits.maxStringChars - minimumStringLimit) * ratio,
    );
    const arrayLimit = Math.floor(limits.maxArrayItems * ratio);
    const counts: JsonTruncationCounts = {
      truncatedStrings: 0,
      omittedStringChars: 0,
      truncatedArrays: 0,
      omittedArrayItems: 0,
    };
    const truncatedResult = truncateJson(jsonResult, stringLimit, arrayLimit, counts);
    const output = JSON.stringify({
      ok: true,
      result: truncatedResult,
      truncated: true,
      originalOutputChars,
      truncation: {
        strategy: "structured",
        ...counts,
      },
    });
    if (output.length <= maxChars) {
      bestOutput = output;
      lowerBound = step + 1;
    } else {
      upperBound = step - 1;
    }
  }

  return bestOutput;
}

export function serializeToolOutput(value: ToolOutputValue, maxChars: number): string {
  const output = JSON.stringify(value);
  if (output.length <= maxChars) return output;
  if (value.ok) {
    const structured = serializeStructuredTruncatedSuccess(
      value.result,
      output.length,
      maxChars,
    );
    if (structured) return structured;
  }
  return serializeTruncatedToolOutput(value, output.length, maxChars);
}

