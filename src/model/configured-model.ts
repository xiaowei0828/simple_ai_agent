import {
  resolveRuntimeModelConfig,
  type AppConfig,
  type RuntimeModelConfig,
} from "../config/app-config.js";
import type { ModelAdapter, ModelRequest, ModelResponse } from "../core/types.js";

/** Select the connection for each request, keeping one client per connection. */
export class ConfiguredModel implements ModelAdapter {
  readonly #clients = new Map<number, ModelAdapter>();

  constructor(
    readonly config: AppConfig,
    readonly createClient: (config: RuntimeModelConfig) => ModelAdapter,
  ) {}

  async respond(request: ModelRequest): Promise<ModelResponse> {
    const selected = resolveRuntimeModelConfig(this.config, request.model);
    if (!selected.apiKey) {
      throw new Error(`API key is not configured for connection ${selected.connectionIndex + 1}. Set apiKey in .config/config.json.`);
    }
    const reasoningEffort = request.reasoningEffort ?? selected.reasoningEffort;
    if (!selected.supportedReasoningEfforts.includes(reasoningEffort)) {
      throw new Error(`Reasoning effort '${reasoningEffort}' is not supported by ${selected.selector}. Choose: ${selected.supportedReasoningEfforts.join(", ")}.`);
    }
    let client = this.#clients.get(selected.connectionIndex);
    if (!client) {
      client = this.createClient(selected);
      this.#clients.set(selected.connectionIndex, client);
    }
    return client.respond({
      ...request,
      model: selected.model,
      reasoningSummary: request.purpose === "compaction" ? undefined : selected.reasoningSummary,
      reasoningEffort,
    });
  }
}
