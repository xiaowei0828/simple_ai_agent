import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import {
  AutoApproveWorkspaceFileOperationsPolicy,
  CallbackApprovalPolicy,
  extractSimpleCommandPrograms,
  ProgramAllowlistApprovalPolicy,
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

  it("auto-approves && and pipeline commands only when every program is allowlisted", async () => {
    const delegatedCommands: string[] = [];
    const fallback = new CallbackApprovalPolicy(async (request) => {
      const command = typeof request.arguments === "object"
        && request.arguments !== null
        && "command" in request.arguments
        && typeof request.arguments.command === "string"
        ? request.arguments.command
        : "";
      delegatedCommands.push(command);
      return false;
    });
    const policy = new ProgramAllowlistApprovalPolicy({
      hasProgram(program) {
        return program === "lark-cli" || program === "date" || program === "head";
      },
    }, fallback);
    const request = (command: string) => ({
      toolName: "run_command",
      risk: "execute" as const,
      arguments: { command, cwd: ".", timeoutMs: 120_000 },
    });

    await expect(policy.approve(request(
      "lark-cli docs +create --content '<title>A &amp; B</title>'",
    ))).resolves.toBe(true);
    await expect(policy.approve(request(
      "date '+%F' && lark-cli docs +fetch --doc x",
    ))).resolves.toBe(true);
    await expect(policy.approve(request(
      "lark-cli docs +fetch --doc x | head -20",
    ))).resolves.toBe(true);
    await expect(policy.approve(request(
      "date \"+%Y-%m-%d %A\" && LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1 LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1 lark-cli auth status --json --verify",
    ))).resolves.toBe(true);
    await expect(policy.approve(request(
      "NOTICE=0 lark-cli docs +fetch --doc x",
    ))).resolves.toBe(true);

    const delegated = [
      "lark-cli docs +fetch --doc x && another-command",
      "lark-cli docs +fetch --doc x | another-command --arg x",
    ];
    for (const command of delegated) {
      await expect(policy.approve(request(command))).resolves.toBe(false);
    }
    expect(delegatedCommands).toEqual(delegated);
  });

  it("extracts programs from && chains and pipelines while skipping environment assignments", () => {
    expect(extractSimpleCommandPrograms("lark-cli docs +fetch --doc x")).toEqual(["lark-cli"]);
    expect(extractSimpleCommandPrograms("date '+%F' && lark-cli docs +fetch --doc x"))
      .toEqual(["date", "lark-cli"]);
    expect(extractSimpleCommandPrograms(
      "date \"+%Y-%m-%d %A\" && LARKSUITE_CLI_NO_UPDATE_NOTIFIER=1 LARKSUITE_CLI_NO_SKILLS_NOTIFIER=1 lark-cli auth status --json --verify",
    )).toEqual(["date", "lark-cli"]);
    expect(extractSimpleCommandPrograms("lark-cli docs +fetch --doc x | head -20"))
      .toEqual(["lark-cli", "head"]);
    expect(extractSimpleCommandPrograms("npm test && npm run build")).toEqual(["npm"]);
    expect(extractSimpleCommandPrograms("./script.sh")).toEqual(["./script.sh"]);
    expect(extractSimpleCommandPrograms("lark-cli docs '$(literal)'"))
      .toEqual(["lark-cli"]);
    expect(extractSimpleCommandPrograms("lark-cli docs +fetch --doc x 2>&1"))
      .toEqual(["lark-cli"]);
    expect(extractSimpleCommandPrograms("lark-cli docs +fetch ; another-command"))
      .toEqual(["lark-cli"]);
    expect(extractSimpleCommandPrograms("lark-cli docs +fetch | another-command"))
      .toEqual(["lark-cli", "another-command"]);
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
