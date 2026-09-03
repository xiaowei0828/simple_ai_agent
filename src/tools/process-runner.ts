import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { commandEnvironment } from "./command-environment.js";

export interface RunProcessOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  maxOutputChars?: number;
}

export interface RunProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
  truncated: boolean;
}

export interface ShellInvocation {
  program: string;
  args: string[];
}

export interface RuntimeShell {
  executable: string;
  displayName: string;
}

const DEFAULT_MAX_OUTPUT_CHARS = 30_000;
const FORCE_KILL_GRACE_MS = 2_000;

export async function runProcess(options: RunProcessOptions): Promise<RunProcessResult> {
  const startedAt = Date.now();
  const output = new BoundedOutput(options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS);
  const detached = process.platform !== "win32";
  const invocation = shellInvocation(options.command);
  const child = spawn(invocation.program, invocation.args, {
    cwd: options.cwd,
    shell: false,
    detached,
    env: commandEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk: Buffer) => output.append(chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => output.append(chunk.toString("utf8")));

  let timedOut = false;
  let forceKillTimer: NodeJS.Timeout | undefined;
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    signalProcessTree(child, "SIGTERM");
    forceKillTimer = setTimeout(() => signalProcessTree(child, "SIGKILL"), FORCE_KILL_GRACE_MS);
  }, options.timeoutMs);

  const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) => {
        resolve({ exitCode, signal });
      });
    },
  ).finally(() => {
    clearTimeout(timeoutTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
  });

  return {
    ...result,
    timedOut,
    durationMs: Date.now() - startedAt,
    output: output.render(),
    truncated: output.truncated,
  };
}

export function shellInvocation(
  command: string,
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): ShellInvocation {
  const shell = resolveRuntimeShell(platform, environment);
  if (platform === "win32") {
    return {
      program: shell.executable,
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    };
  }
  return { program: shell.executable, args: ["-c", command] };
}

export function resolveRuntimeShell(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeShell {
  if (platform === "win32") {
    return { executable: "powershell.exe", displayName: "Windows PowerShell" };
  }
  const executable = environment.SHELL?.trim() || (platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  return { executable, displayName: path.basename(executable) || executable };
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // The process may have exited between the timeout and the signal.
  }
}

class BoundedOutput {
  readonly #headLimit: number;
  readonly #tailLimit: number;
  #head = "";
  #tail = "";
  #totalChars = 0;

  constructor(readonly maxChars: number) {
    this.#headLimit = Math.ceil(maxChars / 2);
    this.#tailLimit = Math.floor(maxChars / 2);
  }

  get truncated(): boolean {
    return this.#totalChars > this.maxChars;
  }

  append(text: string): void {
    this.#totalChars += text.length;
    let remainder = text;
    if (this.#head.length < this.#headLimit) {
      const available = this.#headLimit - this.#head.length;
      this.#head += remainder.slice(0, available);
      remainder = remainder.slice(available);
    }
    if (remainder.length > 0 && this.#tailLimit > 0) {
      this.#tail = `${this.#tail}${remainder}`.slice(-this.#tailLimit);
    }
  }

  render(): string {
    if (!this.truncated) return `${this.#head}${this.#tail}`;
    const omitted = this.#totalChars - this.maxChars;
    return `${this.#head}\n…[${omitted} output characters omitted]…\n${this.#tail}`;
  }
}
