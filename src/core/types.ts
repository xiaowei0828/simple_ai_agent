export type ToolRisk = "write" | "execute";

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

/** Preserve provider output items (including reasoning) when replaying locally. */
export interface ModelOutputItem {
  type: string;
  [key: string]: unknown;
}

export type ModelInputItem = ConversationMessage | ToolCallOutput | ModelOutputItem;
export type ReasoningSummaryMode = "auto" | "concise" | "detailed";

export type ModelStreamEvent =
  | { type: "output_text_delta"; delta: string }
  | { type: "reasoning_summary_delta"; delta: string }
  | { type: "reasoning_text_delta"; delta: string };

export type ModelStreamEventHandler = (
  event: ModelStreamEvent,
) => void | Promise<void>;

export interface ModelRequest {
  model: string;
  instructions: string;
  input: string | ModelInputItem[];
  previousResponseId?: string;
  reasoningSummary?: ReasoningSummaryMode;
  stream?: boolean;
  onStreamEvent?: ModelStreamEventHandler;
  tools: ToolDefinition[];
}

export interface ModelResponse {
  id: string;
  outputText: string;
  reasoningSummary?: string;
  reasoningText?: string;
  reasoningSummaryUnavailable?: boolean;
  toolCalls: ModelToolCall[];
  outputItems?: ModelOutputItem[];
  usage?: Record<string, unknown>;
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
  | { type: "model_requested"; step: number; model: string }
  | { type: "model_output_delta"; step: number; delta: string }
  | { type: "model_reasoning_delta"; step: number; delta: string }
  | { type: "model_response_failed"; step: number }
  | { type: "model_response"; step: number; response: ModelResponse }
  | { type: "tool_requested"; step: number; call: ModelToolCall; risk?: ToolRisk }
  | { type: "approval_requested"; step: number; request: ApprovalRequest }
  | { type: "tool_completed"; step: number; callId: string; toolName: string; result: unknown }
  | { type: "tool_failed"; step: number; callId: string; toolName: string; error: string }
  | { type: "tool_output"; step: number; output: ToolCallOutput }
  | { type: "run_completed"; steps: number; output: string };

export type AgentEventHandler = (event: AgentEvent) => void | Promise<void>;

export interface AgentRunResult {
  output: string;
  steps: number;
  responseId: string;
}
