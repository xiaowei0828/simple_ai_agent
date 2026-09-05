import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach } from "vitest";
import { AgentRunner, type AgentRunnerOptions } from "../src/core/agent-runner.js";
import type { InteractiveIO } from "../src/cli/interactive-session.js";
import { DenyAllApprovalPolicy } from "../src/policy/approval-policy.js";
import { ToolRegistry } from "../src/tools/types.js";


/** Creates temporary directories and removes every one created by the current test. */
export function createTempDirectoryFixture(): (prefix: string) => Promise<string> {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  return async (prefix: string) => {
    const directory = await mkdtemp(path.join(tmpdir(), prefix));
    directories.push(directory);
    return directory;
  };
}

/** Pure model tests start with no executable tools or filesystem fixture. */
export function createTestRunner(options: Pick<AgentRunnerOptions, "model"> & Partial<AgentRunnerOptions>): AgentRunner {
  return new AgentRunner({
    modelName: "test-model", instructions: "test instructions", tools: new ToolRegistry([]),
    toolContext: { workspaceRoot: process.cwd() }, approvalPolicy: new DenyAllApprovalPolicy(),
    ...options,
  });
}

export function scriptedIO(
  inputs: string[],
  outputs: { assistant?: string[]; status?: string[] } = {},
): InteractiveIO {
  return {
    async prompt() { return inputs.shift(); },
    writeAssistant(text) { outputs.assistant?.push(text); },
    writeStatus(text) { outputs.status?.push(text); },
  };
}
