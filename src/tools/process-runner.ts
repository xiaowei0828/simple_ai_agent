import { spawn, type ChildProcess } from "node:child_process";

export interface RunProcessOptions {
  program: string;
  args: string[];
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

const DEFAULT_MAX_OUTPUT_CHARS = 30_000;
const FORCE_KILL_GRACE_MS = 2_000;

export function sanitizedEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const secretName = /(?:api[_-]?key|token|secret|password|credential|cookie|authorization)/i;
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !secretName.test(name)),
  );
}

export async function runProcess(options: RunProcessOptions): Promise<RunProcessResult> {
  const startedAt = Date.now();
  const output = new BoundedOutput(options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS);
  const detached = process.platform !== "win32";
  const child = spawn(options.program, options.args, {
    cwd: options.cwd,
    shell: false,
    detached,
    env: sanitizedEnvironment(),
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
      let settled = false;
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      child.once("close", (exitCode, signal) => {
        if (settled) return;
        settled = true;
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
