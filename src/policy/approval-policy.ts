import { realpath } from "node:fs/promises";
import { isPathInside } from "./path-policy.js";
import type { ApprovalPolicy, ApprovalRequest } from "../core/types.js";

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

  constructor(fallback: ApprovalPolicy, readonly workspaceRoot: string, readonly autoApprove = false) {
    this.#fallback = fallback;
  }

  async approve(request: ApprovalRequest): Promise<boolean> {
    if (this.autoApprove) return true;
    if (request.risk === "write" && request.toolName === "apply_patch") {
      const args = request.arguments as { resolvedPaths?: Record<string, string> } | null;
      const targets = Object.values(args?.resolvedPaths ?? {});
      const root = await realpath(this.workspaceRoot);
      if (targets.length > 0 && targets.every((target) => isPathInside(root, target))) return true;
    }
    return this.#fallback.approve(request);
  }
}
