import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { assertCommandAllowed } from "../src/policy/command-policy.js";
import { createRunCommandTool } from "../src/tools/run-command.js";

describe("command policy", () => {
  it("blocks destructive commands and common structured-command bypasses", () => {
    expect(() => assertCommandAllowed("rm", ["-rf", "build"])).toThrow("blocked");
    expect(() => assertCommandAllowed("git", ["reset", "--hard"])).toThrow("blocked");
    expect(() => assertCommandAllowed("find", [".", "-delete"])).toThrow("blocked");
    expect(() => assertCommandAllowed("bash", ["-c", "echo unsafe"])).toThrow("blocked");
    expect(() => assertCommandAllowed("node", ["-e", "console.log('unsafe')"])).toThrow("blocked");
    expect(() => assertCommandAllowed("xargs", ["rm", "-f"])).toThrow("blocked");
  });

  it("allows normal build, inspection, and search arguments", () => {
    expect(() => assertCommandAllowed("cmake", ["-S", ".", "-B", "build"])).not.toThrow();
    expect(() => assertCommandAllowed("git", ["status", "--short"])).not.toThrow();
    expect(() => assertCommandAllowed("rg", ["rm", "."])).not.toThrow();
  });
});

describe("run_command", () => {
  it("runs a structured command inside the workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-run-command-"));
    const tool = createRunCommandTool();
    const input = tool.parse({
      program: process.execPath,
      args: ["--version"],
      cwd: ".",
      timeoutMs: 10_000,
    });

    await expect(tool.execute(input, { workspaceRoot: root })).resolves.toMatchObject({
      cwd: ".",
      exitCode: 0,
      timedOut: false,
      truncated: false,
    });
  });

  it("applies defaults but rejects a cwd outside the workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-run-command-path-"));
    const tool = createRunCommandTool();
    const input = tool.parse({ program: process.execPath, args: ["--version"] });

    expect(input).toMatchObject({ cwd: ".", timeoutMs: 120_000 });
    await expect(
      tool.execute({ ...input, cwd: ".." }, { workspaceRoot: root }),
    ).rejects.toThrow("escapes");
  });
});
