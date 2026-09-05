import { describe, expect, it } from "vitest";
import { serializeToolOutput, type ToolOutputValue } from "../src/core/tool-output.js";

describe("tool output serialization", () => {
  const content = `BEGIN-${"x".repeat(2_000)}-END`;

  it.each([
    { ok: true, result: { content } },
    { ok: false, error: content },
  ] satisfies ToolOutputValue[])("preserves status and both ends when truncating (ok=$ok)", (value) => {
    const output = serializeToolOutput(value, 400);
    const parsed = JSON.parse(output);
    expect(output.length).toBeLessThanOrEqual(400);
    expect(parsed).toMatchObject({ ok: value.ok, truncated: true, originalOutputChars: JSON.stringify(value).length });
    const text = value.ok ? parsed.result.content : parsed.error;
    expect(text).toMatch(/^BEGIN-.*-END$/);
    if (value.ok) expect(parsed.truncation).toMatchObject({ strategy: "structured", truncatedStrings: 1 });
    else expect(parsed.omittedErrorChars).toBeGreaterThan(0);
  });

  it.each([null, [1, "two"], { output: "short", exitCode: 0 }])("leaves small results unchanged: %j", (result) => {
    expect(serializeToolOutput({ ok: true, result }, 400)).toBe(JSON.stringify({ ok: true, result }));
  });

  it("shortens arrays while retaining object fields and process status", () => {
    const result = { rows: Array.from({ length: 100 }, (_, index) => ({ index, content })), exitCode: 0, timedOut: false };
    const output = serializeToolOutput({ ok: true, result }, 800);
    const parsed = JSON.parse(output);
    expect(output.length).toBeLessThanOrEqual(800);
    expect(parsed.result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(parsed.result.rows.length).toBeLessThan(result.rows.length);
    expect(parsed.result.rows[0].index).toBe(0);
    expect(parsed.truncation.omittedArrayItems).toBe(100 - parsed.result.rows.length);
  });

  it.each([32, 128, 400])("keeps escaped output valid JSON within a %i-character budget", (budget) => {
    for (const value of [
      { ok: true, result: "\"\\\n你好".repeat(500) },
      { ok: false, error: "\"\\\n你好".repeat(500) },
    ] satisfies ToolOutputValue[]) {
      const output = serializeToolOutput(value, budget);
      expect(output.length).toBeLessThanOrEqual(budget);
      expect(JSON.parse(output)).toMatchObject({ ok: value.ok, truncated: true });
    }
  });
});
