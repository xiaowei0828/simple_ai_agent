import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { PreviousResponseUnavailableError } from "../src/core/errors.js";
import { JsonlTraceLogger } from "../src/logging/jsonl-trace-logger.js";
import type { OpenAITraceEntry } from "../src/logging/openai-trace.js";
import { OpenAIModel } from "../src/model/openai-model.js";

describe("raw OpenAI logging", () => {
  it("writes complete JSONL entries to a private file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-log-"));
    const logger = await JsonlTraceLogger.create(path.join(root, ".agent-runs"));

    await logger.log({
      type: "openai.request",
      timestamp: "2026-01-01T00:00:00.000Z",
      traceId: "trace-1",
      endpoint: "https://api.openai.com/v1/responses",
      body: { model: "test-model", input: "hello" },
    });
    await logger.log({
      type: "openai.response",
      timestamp: "2026-01-01T00:00:01.000Z",
      traceId: "trace-1",
      requestId: "req-1",
      durationMs: 1000,
      http: { status: 200, statusText: "OK", headers: { "x-request-id": "req-1" } },
      body: { id: "resp-1", output: [] },
    });
    await logger.close();

    const lines = (await readFile(logger.filePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ type: "openai.request", body: { input: "hello" } });
    expect(lines[1]).toMatchObject({ type: "openai.response", requestId: "req-1" });
    if (process.platform !== "win32") {
      expect((await stat(logger.filePath)).mode & 0o777).toBe(0o600);
    }
  });

  it("captures the SDK request body and full parsed response without credentials", async () => {
    const traces: OpenAITraceEntry[] = [];
    let transmittedBody = "";
    const client = new OpenAI({
      apiKey: "api-key-that-must-not-be-logged",
      baseURL: "https://example.test/v1",
      fetch: async (_input, init) => {
        transmittedBody = String(init?.body ?? "");
        return new Response(JSON.stringify({
          id: "resp-test",
          object: "response",
          created_at: 1,
          status: "completed",
          model: "test-model",
          output: [
            {
              id: "reasoning-test",
              type: "reasoning",
              status: "completed",
              summary: [{ type: "summary_text", text: "I should answer briefly." }],
            },
            {
              id: "msg-test",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [{ type: "output_text", text: "hello", annotations: [], logprobs: [] }],
            },
          ],
          usage: {
            input_tokens: 3,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 1,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 4,
          },
        }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-request-id": "req-test",
            "set-cookie": "must-not-be-logged",
          },
        });
      },
    });
    const model = new OpenAIModel({
      client,
      traceSink: {
        async log(entry) {
          traces.push(entry);
        },
      },
    });

    const result = await model.respond({
      model: "test-model",
      instructions: "full instructions",
      input: "hello",
      previousResponseId: "resp-previous",
      reasoningSummary: "auto",
      tools: [],
    });

    expect(result).toMatchObject({
      id: "resp-test",
      outputText: "hello",
      reasoningSummary: "I should answer briefly.",
    });
    expect(JSON.parse(transmittedBody)).toMatchObject({
      model: "test-model",
      instructions: "full instructions",
      input: "hello",
      previous_response_id: "resp-previous",
      reasoning: { summary: "auto" },
      store: true,
    });
    expect(traces[0]).toMatchObject({
      type: "openai.request",
      body: { instructions: "full instructions", input: "hello" },
    });
    expect(traces[1]).toMatchObject({
      type: "openai.response",
      requestId: "req-test",
      body: { id: "resp-test", usage: { total_tokens: 4 } },
      http: { status: 200, headers: { "x-request-id": "req-test" } },
    });
    expect(JSON.stringify(traces)).not.toContain("api-key-that-must-not-be-logged");
    expect(JSON.stringify(traces)).not.toContain("must-not-be-logged");
  });

  it("retries without reasoning summaries when a compatible endpoint rejects them", async () => {
    const transmittedBodies: Array<Record<string, unknown>> = [];
    let requestCount = 0;
    const client = new OpenAI({
      apiKey: "test-key",
      baseURL: "https://example.test/v1",
      fetch: async (_input, init) => {
        requestCount += 1;
        transmittedBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        if (requestCount === 1) {
          return new Response(JSON.stringify({
            error: {
              message: "Unknown parameter: reasoning.summary",
              type: "invalid_request_error",
            },
          }), {
            status: 400,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({
          id: `resp-${requestCount}`,
          object: "response",
          created_at: 1,
          status: "completed",
          model: "test-model",
          output: [{
            id: `msg-${requestCount}`,
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: "hello", annotations: [], logprobs: [] }],
          }],
          usage: {
            input_tokens: 1,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 1,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 2,
          },
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const model = new OpenAIModel({ client });
    const request = {
      model: "test-model",
      instructions: "test instructions",
      input: "hello",
      reasoningSummary: "auto" as const,
      tools: [],
    };

    const recovered = await model.respond(request);
    const cachedFallback = await model.respond(request);

    expect(recovered.reasoningSummaryUnavailable).toBe(true);
    expect(cachedFallback.reasoningSummaryUnavailable).toBeUndefined();
    expect(requestCount).toBe(3);
    expect(transmittedBodies[0]).toMatchObject({ reasoning: { summary: "auto" } });
    expect(transmittedBodies[1]).not.toHaveProperty("reasoning");
    expect(transmittedBodies[2]).not.toHaveProperty("reasoning");
  });

  it("classifies an unavailable previous response for local replay", async () => {
    const client = new OpenAI({
      apiKey: "test-key",
      baseURL: "https://example.test/v1",
      fetch: async () => new Response(JSON.stringify({
        error: {
          message: "The previous_response_id was not found.",
          type: "invalid_request_error",
        },
      }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    });
    const model = new OpenAIModel({ client });

    await expect(model.respond({
      model: "test-model",
      instructions: "test instructions",
      input: "follow up",
      previousResponseId: "response-old",
      tools: [],
    })).rejects.toBeInstanceOf(PreviousResponseUnavailableError);
  });
});
