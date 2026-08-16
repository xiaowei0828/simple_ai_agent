import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import {
  AutoApproveWorkspaceFileOperationsPolicy,
  CallbackApprovalPolicy,
} from "../src/policy/approval-policy.js";
import { resolveRuntimeShell, shellInvocation } from "../src/tools/process-runner.js";
import { createRunCommandTool } from "../src/tools/run-command.js";

describe("approval policy", () => {
  it("auto-approves workspace file tools and delegates every run_command", async () => {
    const fallbackRequests: string[] = [];
    const fallback = new CallbackApprovalPolicy(async (request) => {
      fallbackRequests.push(request.toolName);
      return false;
    });
    const policy = new AutoApproveWorkspaceFileOperationsPolicy(fallback);

    for (const toolName of ["write_file", "replace_in_file", "delete_file"]) {
      await expect(policy.approve({
        toolName,
        risk: "write",
        arguments: { path: "src/example.ts" },
      })).resolves.toBe(true);
    }
    await expect(policy.approve({
      toolName: "run_command",
      risk: "execute",
      arguments: { command: "npm test", cwd: ".", timeoutMs: 120_000 },
    })).resolves.toBe(false);
    await expect(policy.approve({
      toolName: "unknown_write_tool",
      risk: "write",
      arguments: {},
    })).resolves.toBe(false);

    expect(fallbackRequests).toEqual(["run_command", "unknown_write_tool"]);
  });

});

describe("shell invocation", () => {
  it("uses non-interactive PowerShell and passes shell operators unchanged on Windows", () => {
    const command = "Write-Output one && Get-Content file.txt | Select-Object -First 1";

    expect(resolveRuntimeShell("win32", {})).toEqual({
      executable: "powershell.exe",
      displayName: "Windows PowerShell",
    });
    expect(shellInvocation(command, "win32", {})).toEqual({
      program: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    });
  });

  it("uses the non-interactive default shell on macOS", () => {
    const command = "printf one && printf two | sed 's/two/three/'";

    expect(resolveRuntimeShell("darwin", { SHELL: "/bin/fish" })).toEqual({
      executable: "/bin/fish",
      displayName: "fish",
    });
    expect(shellInvocation(command, "darwin", { SHELL: "/bin/fish" })).toEqual({
      program: "/bin/fish",
      args: ["-c", command],
    });
    expect(shellInvocation(command, "darwin", {})).toEqual({
      program: "/bin/zsh",
      args: ["-c", command],
    });
  });

  it("uses SHELL with a sh fallback on other Unix platforms", () => {
    expect(shellInvocation("echo ok", "linux", {})).toEqual({
      program: "/bin/sh",
      args: ["-c", "echo ok"],
    });
  });
});

describe("run_command", () => {
  it("runs a command string inside the workspace", async () => {
    const tool = createRunCommandTool();
    const input = tool.parse({
      command: "node --version",
      cwd: ".",
      timeoutMs: 10_000,
    });

    await expect(tool.execute(input, { workspaceRoot: process.cwd() })).resolves.toMatchObject({
      command: "node --version",
      cwd: ".",
      exitCode: 0,
      timedOut: false,
      truncated: false,
    });
  });

  it("lets the active shell evaluate pipelines and chaining", async () => {
    const tool = createRunCommandTool();
    const command = process.platform === "win32"
      ? "Write-Output first | ForEach-Object { \"$($_)-second\" }"
      : "printf first && printf '%s' '-second'";

    const result = await tool.execute(
      tool.parse({ command, cwd: ".", timeoutMs: 10_000 }),
      { workspaceRoot: process.cwd() },
    ) as { exitCode: number | null; output: string };

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("first-second");
  });

  it.runIf(process.platform === "win32")("runs Windows command wrappers through PowerShell", async () => {
    const tool = createRunCommandTool();
    const input = tool.parse({ command: "npm.cmd --version" });

    await expect(tool.execute(input, { workspaceRoot: process.cwd() })).resolves.toMatchObject({
      exitCode: 0,
      timedOut: false,
    });
  });

  it("applies defaults but rejects a cwd outside the workspace", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "simple-code-agent-run-command-path-"));
    const tool = createRunCommandTool();
    const input = tool.parse({ command: "node --version" });

    expect(input).toMatchObject({ cwd: ".", timeoutMs: 120_000 });
    await expect(
      tool.execute({ ...input, cwd: ".." }, { workspaceRoot: root }),
    ).rejects.toThrow("escapes");
  });
});
