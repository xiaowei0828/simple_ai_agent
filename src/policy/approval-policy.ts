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
