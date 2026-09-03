import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { runInteractiveSession } from "../src/cli/interactive-session.js";
import { listConfiguredModels, resolveRuntimeModelConfig, type AppConfig, type RuntimeModelConfig } from "../src/config/app-config.js";
import { AgentRunner } from "../src/core/agent-runner.js";
import type { ModelRequest } from "../src/core/types.js";
import { JsonlConversationStore } from "../src/history/session-store.js";
import { ConfiguredModel } from "../src/model/configured-model.js";
import { OpenAIModel } from "../src/model/openai-model.js";
import { DenyAllApprovalPolicy } from "../src/policy/approval-policy.js";
import { createDefaultToolRegistry } from "../src/tools/index.js";

const config: AppConfig = {
  defaults: { reasoningEffort: "medium", reasoningSummary: "detailed" },
  connections: [
    { apiKey: "first-fixture-key", baseUrl: "https://first.test/v1", models: [{ id: "shared", supportedReasoningEfforts: ["low", "medium", "high"] }] },
    { apiKey: "second-fixture-key", baseUrl: "https://second.test/v1", models: [{ id: "shared", reasoningSummary: "off", reasoningEffort: "low", supportedReasoningEfforts: ["low", "high"] }, { id: "other", reasoningEffort: "high" }] },
  ],
};

const request: ModelRequest = {
  model: "1:shared", instructions: "test", input: "hello", tools: [], stream: false,
};

describe("ConfiguredModel", () => {
  it("sends the selected connection's endpoint, credentials, raw model name, and reasoning setting", async () => {
    const sent: Array<{ url: string; authorization: string | null; body: Record<string, unknown> }> = [];
    const model = new ConfiguredModel(config, (connection) => new OpenAIModel({
      client: new OpenAI({
        apiKey: connection.apiKey,
        baseURL: connection.baseUrl,
        maxRetries: 0,
        fetch: async (input, init) => {
          sent.push({
            url: String(input),
            authorization: new Headers(init?.headers).get("authorization"),
            body: JSON.parse(String(init?.body)) as Record<string, unknown>,
          });
          return new Response(JSON.stringify({
            id: `response-${sent.length}`, object: "response", status: "completed", output: [], output_text: "ok",
          }), { status: 200, headers: { "content-type": "application/json" } });
        },
      }),
    }));
    await model.respond(request);
    await model.respond({ ...request, model: "2:shared", reasoningSummary: "auto" });
    expect(sent).toMatchObject([
      { url: "https://first.test/v1/responses", authorization: "Bearer first-fixture-key", body: { model: "shared", reasoning: { summary: "detailed" } } },
      { url: "https://second.test/v1/responses", authorization: "Bearer second-fixture-key", body: { model: "shared" } },
    ]);
    expect(sent[0]!.body.reasoning).toEqual({ summary: "detailed", effort: "medium" });
    expect(sent[1]!.body.reasoning).toEqual({ effort: "low" });
  });

  it("routes interactive switches and resumed history while keeping response chains within a connection", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-agent-connections-"));
    try {
      const store = new JsonlConversationStore(path.join(root, ".agent-runs"));
      const clients: RuntimeModelConfig[] = [];
      const requests: Array<{ connection: number; request: ModelRequest }> = [];
      const model = new ConfiguredModel(config, (connection) => {
        clients.push(connection);
        return {
          async respond(input) {
            requests.push({ connection: connection.connectionIndex, request: input });
            return { id: `response-${requests.length}`, outputText: "ok", toolCalls: [] };
          },
        };
      });
      const runner = new AgentRunner({
        model, modelName: "1:shared", instructions: "test", tools: createDefaultToolRegistry(),
        toolContext: { workspaceRoot: root }, approvalPolicy: new DenyAllApprovalPolicy(),
        onEvent: (event) => store.recordAgentEvent(event),
      });
      const inputs = ["first", "/reasoning high", "follow up", "/model 2", "second", "/model other", "third", "/exit"];
      await runInteractiveSession({
        agent: runner, initialModel: "1:shared",
        availableModels: listConfiguredModels(config).map((choice) => choice.selector),
        reasoningConfig: (name) => resolveRuntimeModelConfig(config, name),
        historyStore: store,
        io: { async prompt() { return inputs.shift(); }, writeAssistant() {}, writeStatus() {} },
      });
      expect(requests.map(({ connection, request: input }) => [connection, input.model, input.previousResponseId]))
        .toEqual([[0, "shared", undefined], [0, "shared", "response-1"], [1, "shared", undefined], [1, "other", undefined]]);
      expect(requests.every(({ request: input }) => input.stream && input.onStreamEvent)).toBe(true);
      expect(requests.map(({ request: input }) => input.reasoningEffort)).toEqual(["medium", "high", "low", "high"]);
      expect(clients.map((client) => client.connectionIndex)).toEqual([0, 1]);

      const saved = (await store.list()).find((conversation) => conversation.model === "2:shared")!;
      const resume = [saved.id, "resumed", "/exit"];
      await runInteractiveSession({
        agent: runner, initialModel: "1:shared", historyStore: store,
        availableModels: listConfiguredModels(config).map((choice) => choice.selector),
        reasoningConfig: (name) => resolveRuntimeModelConfig(config, name),
        io: { async prompt() { return resume.shift(); }, writeAssistant() {}, writeStatus() {} },
      });
      expect(requests.at(-1)).toMatchObject({ connection: 1, request: {
        model: "shared", previousResponseId: undefined,
        input: [
          { role: "user", content: "second" },
          { role: "assistant", content: "ok" },
          { role: "user", content: "resumed" },
        ],
      } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("validates requested effort before opening a connection and honors overrides for normal and summary requests", async () => {
    const sent: ModelRequest[] = [];
    let clients = 0;
    const model = new ConfiguredModel(config, () => {
      clients++;
      return { async respond(input) {
        sent.push(input);
        return { id: "response", outputText: "ok", toolCalls: [] };
      } };
    });
    await expect(model.respond({ ...request, reasoningEffort: "max" })).rejects.toThrow("not supported");
    expect(clients).toBe(0);
    expect(sent).toEqual([]);
    await model.respond({ ...request, reasoningEffort: "low" });
    await model.respond({ ...request, purpose: "compaction", reasoningEffort: "high" });
    await model.respond(request);
    expect(sent.map((input) => input.reasoningEffort)).toEqual(["low", "high", "medium"]);
    expect(sent[1]!.reasoningSummary).toBeUndefined();
    expect(clients).toBe(1);
  });

  it("does not create a client or fall back to another connection for an unknown model or missing key", async () => {
    let created = 0;
    const model = new ConfiguredModel({ connections: [{ ...config.connections[0]!, apiKey: "" }] }, () => {
      created += 1;
      throw new Error("must not create a client");
    });
    await expect(model.respond({ ...request, model: "missing" })).rejects.toThrow("Unknown model");
    await expect(model.respond({ ...request, model: "shared" })).rejects.toThrow("API key is not configured");
    expect(created).toBe(0);
  });
});
