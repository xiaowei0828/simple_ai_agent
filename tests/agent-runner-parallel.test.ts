import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentRunner } from "../src/core/agent-runner.js";
import type { ModelAdapter, ModelRequest, ModelResponse, ToolRisk } from "../src/core/types.js";
import { AllowAllApprovalPolicy } from "../src/policy/approval-policy.js";
import type { AgentTool } from "../src/tools/types.js";
import { ToolRegistry } from "../src/tools/types.js";

class ScriptedModel implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  readonly #responses: ModelResponse[];

  constructor(responses: ModelResponse[]) {
    this.#responses = [...responses];
  }

  async respond(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const response = this.#responses.shift();
    if (!response) throw new Error("No scripted response remains.");
    return response;
  }
}

function createTrackedTool(
  name: string,
  risk: ToolRisk,
  trackExecution: () => Promise<void>,
  executionMode?: "parallel" | "sequential",
): AgentTool<Record<string, never>> {
  return {
    risk,
    ...(executionMode ? { executionMode } : {}),
    definition: {
      type: "function",
      name,
      description: "Test tool.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      strict: true,
    },
    parse: () => ({}),
    async execute() {
      await trackExecution();
      return { name };
    },
  };
}

function toolBatch(names: string[]): ModelResponse[] {
  return [
    {
      id: "response-tools",
      outputText: "",
      toolCalls: names.map((name, index) => ({
        callId: `call-${index}`,
        name,
        arguments: "{}",
      })),
    },
    { id: "response-final", outputText: "Done.", toolCalls: [] },
  ];
}

describe("AgentRunner parallel tool execution", () => {
  it("runs a batch of independent read tools concurrently and preserves output order", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-agent-parallel-read-"));
    let activeCalls = 0;
    let maximumActiveCalls = 0;
    const trackExecution = async () => {
      activeCalls += 1;
      maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      activeCalls -= 1;
    };
    const model = new ScriptedModel(toolBatch(["read_one", "read_two"]));
    const runner = new AgentRunner({
      model,
      modelName: "test-model",
      instructions: "test",
      tools: new ToolRegistry([
        createTrackedTool("read_one", "read", trackExecution, "parallel"),
        createTrackedTool("read_two", "read", trackExecution, "parallel"),
      ]),
      toolContext: { workspaceRoot: root },
      approvalPolicy: new AllowAllApprovalPolicy(),
    });

    await runner.run("Read in parallel.");

    expect(maximumActiveCalls).toBe(2);
    expect(model.requests[1]?.input).toEqual([
      expect.objectContaining({ call_id: "call-0" }),
      expect.objectContaining({ call_id: "call-1" }),
    ]);
  });

  it("keeps the whole batch sequential when it contains a write", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-agent-sequential-write-"));
    let activeCalls = 0;
    let maximumActiveCalls = 0;
    const trackExecution = async () => {
      activeCalls += 1;
      maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      activeCalls -= 1;
    };
    const model = new ScriptedModel(toolBatch(["read_one", "write_one"]));
    const runner = new AgentRunner({
      model,
      modelName: "test-model",
      instructions: "test",
      tools: new ToolRegistry([
        createTrackedTool("read_one", "read", trackExecution, "parallel"),
        createTrackedTool("write_one", "write", trackExecution),
      ]),
      toolContext: { workspaceRoot: root },
      approvalPolicy: new AllowAllApprovalPolicy(),
    });

    await runner.run("Keep writes ordered.");

    expect(maximumActiveCalls).toBe(1);
  });

  it("does not infer parallel safety from read risk alone", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-agent-opt-in-read-"));
    let activeCalls = 0;
    let maximumActiveCalls = 0;
    const trackExecution = async () => {
      activeCalls += 1;
      maximumActiveCalls = Math.max(maximumActiveCalls, activeCalls);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      activeCalls -= 1;
    };
    const runner = new AgentRunner({
      model: new ScriptedModel(toolBatch(["stateful_read", "parallel_read"])),
      modelName: "test-model",
      instructions: "test",
      tools: new ToolRegistry([
        createTrackedTool("stateful_read", "read", trackExecution),
        createTrackedTool("parallel_read", "read", trackExecution, "parallel"),
      ]),
      toolContext: { workspaceRoot: root },
      approvalPolicy: new AllowAllApprovalPolicy(),
    });

    await runner.run("Respect explicit execution modes.");

    expect(maximumActiveCalls).toBe(1);
  });

  it("approves and executes state-changing calls one at a time in model order", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-agent-approval-order-"));
    const events: string[] = [];
    const createWriteTool = (name: string) => createTrackedTool(name, "write", async () => {
      events.push(`execute:${name}`);
    });
    const runner = new AgentRunner({
      model: new ScriptedModel(toolBatch(["write_one", "write_two"])),
      modelName: "test-model",
      instructions: "test",
      tools: new ToolRegistry([createWriteTool("write_one"), createWriteTool("write_two")]),
      toolContext: { workspaceRoot: root },
      approvalPolicy: {
        async approve(request) {
          events.push(`approve:${request.toolName}`);
          return true;
        },
      },
    });

    await runner.run("Keep approval boundaries explicit.");

    expect(events).toEqual([
      "approve:write_one",
      "execute:write_one",
      "approve:write_two",
      "execute:write_two",
    ]);
  });
});
