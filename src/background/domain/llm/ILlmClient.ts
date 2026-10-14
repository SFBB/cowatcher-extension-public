import { LLMProvider } from '@shared/domain/entities/PipelineTypes';

export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmChatRequest {
  model?: string;
  messages: LlmChatMessage[];
  temperature?: number;
  jsonMode?: boolean;
  signal?: AbortSignal;
}

export interface LlmConnectionTestResult {
  ok: boolean;
  message?: string;
  models?: string[];
  keyInfo?: Record<string, unknown>;
}

import { LlmRole, AiCapability } from './LlmRole';

/**
 * Driver interface for specific LLM Providers (e.g. Ollama, OpenRouter).
 * Completely decouples downstream consumers from HTTP request formats and schemas.
 */
export interface ILlmClient {
  readonly providerId: LLMProvider;
  readonly role: LlmRole;
  readonly model: string;

  chat(request: Omit<LlmChatRequest, 'model'> & { model?: string }): Promise<string>;

  getCapability(): Promise<AiCapability>;

  checkConnection(options?: {
    endpoint?: string;
    apiKey?: string;
  }): Promise<LlmConnectionTestResult>;
}
