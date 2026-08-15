import type { ApprovalPolicy, ApprovalRequest } from "../core/types.js";

const WORKSPACE_FILE_TOOLS = new Set([
  "delete_file",
  "replace_in_file",
  "write_file",
]);

export class AllowAllApprovalPolicy implements ApprovalPolicy {
  async approve(): Promise<boolean> {
    return true;
  }
}

export class DenyAllApprovalPolicy implements ApprovalPolicy {
  async approve(): Promise<boolean> {
    return false;
  }
}

export class CallbackApprovalPolicy implements ApprovalPolicy {
  readonly #callback: (request: ApprovalRequest) => boolean | Promise<boolean>;

  constructor(callback: (request: ApprovalRequest) => boolean | Promise<boolean>) {
    this.#callback = callback;
  }

  async approve(request: ApprovalRequest): Promise<boolean> {
    return this.#callback(request);
  }
}

export interface ProgramAllowlist {
  hasProgram(program: string): boolean;
}

export class ProgramAllowlistApprovalPolicy implements ApprovalPolicy {
  readonly #allowlist: ProgramAllowlist;
  readonly #fallback: ApprovalPolicy;

  constructor(allowlist: ProgramAllowlist, fallback: ApprovalPolicy) {
    this.#allowlist = allowlist;
    this.#fallback = fallback;
  }

  async approve(request: ApprovalRequest): Promise<boolean> {
    const command = extractRunCommand(request);
    const programs = command ? extractSimpleCommandPrograms(command) : undefined;
    if (programs?.every((program) => this.#allowlist.hasProgram(program))) return true;
    return this.#fallback.approve(request);
  }
}

export class AutoApproveWorkspaceFileOperationsPolicy implements ApprovalPolicy {
  readonly #fallback: ApprovalPolicy;

  constructor(fallback: ApprovalPolicy) {
    this.#fallback = fallback;
  }

  async approve(request: ApprovalRequest): Promise<boolean> {
    if (request.risk === "write" && WORKSPACE_FILE_TOOLS.has(request.toolName)) {
      return true;
    }
    return this.#fallback.approve(request);
  }
}

export function extractSimpleCommandPrograms(command: string): string[] | undefined {
  const trimmed = command.trim();
  if (!trimmed) return undefined;

  const programs = trimmed.split(/&&|\|/u).map((part) => {
    const tokens = part.trim().split(/\s+/u);
    return tokens.find((token) => token && !/^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(token));
  });
  if (programs.some((program) => !program)) return undefined;
  return [...new Set(programs as string[])];
}

function extractRunCommand(request: ApprovalRequest): string | undefined {
  if (request.toolName !== "run_command" || request.risk !== "execute") return undefined;
  if (typeof request.arguments !== "object" || request.arguments === null) return undefined;
  if (!("command" in request.arguments)) return undefined;
  return typeof request.arguments.command === "string" ? request.arguments.command : undefined;
}
