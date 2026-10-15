import { ILlmClient } from "../../domain/llm/ILlmClient";
import { LlmRole } from "../../domain/llm/LlmRole";
import { OllamaClient } from "./OllamaClient";
import { OpenRouterClient } from "./OpenRouterClient";
import { LLMProvider } from "@shared/domain/entities/PipelineTypes";

export class LlmClientFactory {
  private static instances = new Map<string, ILlmClient>();

  static async getOrCreateClient(
    provider: LLMProvider,
    role: LlmRole,
    model: string | null,
  ): Promise<ILlmClient> {
    const modelKey = model ?? "unknown";
    const key = `${provider}:${role}:${modelKey}`;
    let client = this.instances.get(key);
    if (!client) {
      switch (provider) {
        case "openrouter":
          client = new OpenRouterClient(role, model ?? "");
          break;
        case "ollama":
          client = new OllamaClient(role, model ?? "");
          break;
      }
      if (client) {
        await client.init();
        this.instances.set(key, client);
      }
    }
    return client;
  }
}
