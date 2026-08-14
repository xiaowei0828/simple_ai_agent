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
