import { ILlmClient } from '../../domain/llm/ILlmClient';
import { LlmRole } from '../../domain/llm/LlmRole';
import { OllamaClient } from './OllamaClient';
import { OpenRouterClient } from './OpenRouterClient';
import { LLMProvider } from '@shared/domain/entities/PipelineTypes';

export class LlmClientFactory {
  static createClient(provider: LLMProvider, role: LlmRole, model: string): ILlmClient {
    if (provider === 'openrouter') {
      return new OpenRouterClient(role, model);
    }
    return new OllamaClient(role, model);
  }
}
