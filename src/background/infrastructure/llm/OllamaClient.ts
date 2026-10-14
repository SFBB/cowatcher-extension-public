import { ILlmClient, LlmChatRequest, LlmConnectionTestResult } from '../../domain/llm/ILlmClient';
import { LlmRole, AiCapability } from '../../domain/llm/LlmRole';
import { LLMProvider } from '@shared/domain/entities/PipelineTypes';
import { DEFAULT_SETTINGS, ExtensionSettings } from '@shared/domain/constants/SettingsDefaults';
import { NCW_STORAGE_KEYS } from '@shared/domain/constants/StorageKeys';
import { BrowserStorageFactory } from '@shared/infrastructure/storage/BrowserStorageFactory';
import { IBrowserStorage } from '@shared/infrastructure/storage/IBrowserStorage';

export class OllamaClient implements ILlmClient {
  readonly providerId: LLMProvider = 'ollama';
  readonly role: LlmRole;
  readonly model: string;

  private host: string = DEFAULT_SETTINGS.ollamaHost;
  private storage: IBrowserStorage;

  constructor(
    role: LlmRole,
    model: string,
    storage: IBrowserStorage = BrowserStorageFactory.getStorage()
  ) {
    this.role = role;
    this.model = model;
    this.storage = storage;

    this.initFromStorage();
    this.storage.onChanged((changes) => {
      if (changes[NCW_STORAGE_KEYS.SETTINGS]?.newValue) {
        const settings = changes[NCW_STORAGE_KEYS.SETTINGS].newValue as Partial<ExtensionSettings>;
        if (settings.ollamaHost) {
          this.host = settings.ollamaHost;
        }
      }
    });
  }

  private async initFromStorage(): Promise<void> {
    const res = await this.storage.get<Partial<ExtensionSettings>>([NCW_STORAGE_KEYS.SETTINGS]);
    const host = res?.[NCW_STORAGE_KEYS.SETTINGS]?.ollamaHost;
    if (host) {
      this.host = host;
    }
  }

  async getCapability(): Promise<AiCapability> {
    const isSupervisor = this.role === 'supervisor';
    return {
      hasAi: true,
      provider: 'ollama',
      model: this.model,
      isSupervisor,
    };
  }

  async chat(request: Omit<LlmChatRequest, 'model'> & { model?: string }): Promise<string> {
    const { model, messages, temperature = 0.2, jsonMode = false, signal } = request;
    const host = (this.host || 'http://localhost:11434').replace(/\/+$/, '');
    const modelToUse = model || this.model || 'translategemma:4b';

    const payload: Record<string, unknown> = {
      model: modelToUse,
      messages,
      stream: false,
      options: { temperature },
    };
    if (jsonMode) {
      payload.format = 'json';
    }

    const response = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });

    if (!response.ok) {
      if (response.status === 403) {
        throw new Error(
          '403 Forbidden: Ollama Origin verification blocked. Please configure OLLAMA_ORIGINS="*" or reload the extension.'
        );
      }
      const errorText = await response.text();
      throw new Error(`Ollama API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();
    return data.message?.content || '';
  }

  async checkConnection(): Promise<LlmConnectionTestResult> {
    const host = this.host;
    const url = `${host}/api/tags`;

    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!res.ok) {
      if (res.status === 403) {
        throw new Error(
          '403 Forbidden: Ollama Origin verification blocked. Please configure OLLAMA_ORIGINS="*" or reload extension.'
        );
      }
      throw new Error(`Ollama returned status ${res.status}: ${res.statusText}`);
    }

    const data = await res.json();
    const rawList = Array.isArray(data.models) ? data.models : [];
    const models = rawList.map((m: { name?: string; model?: string }) => m.name || m.model || '');
    return { ok: true, models };
  }
}
