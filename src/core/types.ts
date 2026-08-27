export type ToolRisk = "read" | "write" | "execute";

export interface ToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
}

export interface ModelToolCall {
  callId: string;
  name: string;
  arguments: string;
}

export interface ToolCallOutput {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export type ModelInputItem = ConversationMessage | ToolCallOutput;
export type ReasoningSummaryMode = "auto" | "concise" | "detailed";

export interface ModelRequest {
  model: string;
  instructions: string;
  input: string | ModelInputItem[];
  previousResponseId?: string;
  reasoningSummary?: ReasoningSummaryMode;
  tools: ToolDefinition[];
}

export interface ModelResponse {
  id: string;
  outputText: string;
  reasoningSummary?: string;
  reasoningSummaryUnavailable?: boolean;
  toolCalls: ModelToolCall[];
}

export interface ModelAdapter {
  respond(request: ModelRequest): Promise<ModelResponse>;
}

export interface ApprovalRequest {
  toolName: string;
  risk: ToolRisk;
  arguments: unknown;
}

export interface ApprovalPolicy {
  approve(request: ApprovalRequest): Promise<boolean>;
}

export type AgentEvent =
  | { type: "run_started"; task: string }
  | { type: "model_response"; step: number; response: ModelResponse }
  | { type: "tool_requested"; step: number; call: ModelToolCall; risk?: ToolRisk }
  | { type: "approval_requested"; step: number; request: ApprovalRequest }
  | { type: "tool_completed"; step: number; toolName: string; result: unknown }
  | { type: "tool_failed"; step: number; toolName: string; error: string }
  | { type: "run_completed"; steps: number; output: string };

export type AgentEventHandler = (event: AgentEvent) => void | Promise<void>;

export interface AgentRunResult {
  output: string;
  steps: number;
  responseId: string;
}
