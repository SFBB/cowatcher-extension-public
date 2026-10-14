/**
 * LLM Service
 * Manages active LLM provider and client instances for translator and supervisor roles.
 * Dispatches chat calls by role without exposing provider/credentials to callers.
 */

import { OpenRouterModelItem } from '@shared/types/Messages';
import { DEFAULT_SETTINGS, ExtensionSettings } from '@shared/domain/constants/SettingsDefaults';
import { NCW_STORAGE_KEYS } from '@shared/domain/constants/StorageKeys';
import { BrowserStorageFactory } from '@shared/infrastructure/storage/BrowserStorageFactory';
import { IBrowserStorage } from '@shared/infrastructure/storage/IBrowserStorage';
import { LLMProvider } from '@shared/domain/entities/PipelineTypes';
import { LlmRole, AiCapability } from '../../domain/llm/LlmRole';
import { ILlmClient, LlmChatMessage } from '../../domain/llm/ILlmClient';
import { LlmClientFactory } from '../../infrastructure/llm/LlmClientFactory';
import { OllamaClient } from '../../infrastructure/llm/OllamaClient';
import { OpenRouterClient } from '../../infrastructure/llm/OpenRouterClient';

export interface LlmRoleChatParams {
  messages: LlmChatMessage[];
  temperature?: number;
  jsonMode?: boolean;
  signal?: AbortSignal;
}

export class LlmService {
  private static instance: LlmService | null = null;
  private storage: IBrowserStorage;

  private activeProvider: LLMProvider = 'ollama';
  private translatorModel: string = DEFAULT_SETTINGS.ollamaModel;
  private supervisorModel: string = DEFAULT_SETTINGS.supervisorModel;
  private enableSupervisor: boolean = DEFAULT_SETTINGS.enableSupervisor;

  private translatorClient: ILlmClient | null = null;
  private supervisorClient: ILlmClient | null = null;

  private constructor(storage: IBrowserStorage = BrowserStorageFactory.getStorage()) {
    this.storage = storage;
    this.initClientsFromSettings(DEFAULT_SETTINGS);
    this.initFromStorage();

    this.storage.onChanged((changes) => {
      if (changes[NCW_STORAGE_KEYS.SETTINGS]?.newValue) {
        this.updateFromSettings(
          changes[NCW_STORAGE_KEYS.SETTINGS].newValue as Partial<ExtensionSettings>
        );
      }
    });
  }

  static getInstance(storage?: IBrowserStorage): LlmService {
    if (!LlmService.instance) {
      LlmService.instance = new LlmService(storage);
    }
    return LlmService.instance;
  }

  private resolveProvider(rawProvider?: string): LLMProvider {
    return rawProvider === 'openrouter' ? 'openrouter' : 'ollama';
  }

  private resolveModels(
    provider: LLMProvider,
    settings: Partial<ExtensionSettings>
  ): { translatorModel: string; supervisorModel: string } {
    if (provider === 'openrouter') {
      const translatorModel =
        settings.openrouterTranslationModel?.trim() ||
        DEFAULT_SETTINGS.openrouterTranslationModel ||
        'deepseek/deepseek-chat';
      const supervisorModel =
        settings.openrouterSupervisorModel?.trim() ||
        DEFAULT_SETTINGS.openrouterSupervisorModel ||
        'google/gemini-2.5-flash';
      return { translatorModel, supervisorModel };
    }

    const translatorModel =
      settings.translationModel?.trim() ||
      settings.ollamaModel?.trim() ||
      DEFAULT_SETTINGS.ollamaModel ||
      'translategemma:4b';
    const supervisorModel =
      settings.supervisorModel?.trim() ||
      settings.ollamaModel?.trim() ||
      DEFAULT_SETTINGS.supervisorModel ||
      'translategemma:4b';

    return { translatorModel, supervisorModel };
  }

  private initClientsFromSettings(settings: Partial<ExtensionSettings>): void {
    const provider = this.resolveProvider(settings.aiProvider);
    const { translatorModel, supervisorModel } = this.resolveModels(provider, settings);
    const enableSupervisor =
      settings.enableSupervisor !== undefined ? settings.enableSupervisor : this.enableSupervisor;

    this.activeProvider = provider;
    this.translatorModel = translatorModel;
    this.supervisorModel = supervisorModel;
    this.enableSupervisor = enableSupervisor;

    this.translatorClient = LlmClientFactory.createClient(
      this.activeProvider,
      'translator',
      this.translatorModel
    );
    this.supervisorClient = LlmClientFactory.createClient(
      this.activeProvider,
      'supervisor',
      this.supervisorModel
    );
  }

  async initFromStorage(): Promise<void> {
    const res = await this.storage.get<Partial<ExtensionSettings>>([NCW_STORAGE_KEYS.SETTINGS]);
    if (res?.[NCW_STORAGE_KEYS.SETTINGS]) {
      this.updateFromSettings(res[NCW_STORAGE_KEYS.SETTINGS]);
    }
  }

  updateFromSettings(settings: Partial<ExtensionSettings>): void {
    if (!settings) return;

    const newProvider = settings.aiProvider
      ? this.resolveProvider(settings.aiProvider)
      : this.activeProvider;
    const { translatorModel: newTransModel, supervisorModel: newSupModel } = this.resolveModels(
      newProvider,
      settings
    );
    const newEnableSupervisor =
      settings.enableSupervisor !== undefined ? settings.enableSupervisor : this.enableSupervisor;

    const providerChanged = newProvider !== this.activeProvider;
    const transModelChanged = newTransModel !== this.translatorModel;
    const supModelChanged = newSupModel !== this.supervisorModel;

    this.activeProvider = newProvider;
    this.translatorModel = newTransModel;
    this.supervisorModel = newSupModel;
    this.enableSupervisor = newEnableSupervisor;

    if (providerChanged || transModelChanged || !this.translatorClient) {
      this.translatorClient = LlmClientFactory.createClient(
        this.activeProvider,
        'translator',
        this.translatorModel
      );
    }

    if (providerChanged || supModelChanged || !this.supervisorClient) {
      this.supervisorClient = LlmClientFactory.createClient(
        this.activeProvider,
        'supervisor',
        this.supervisorModel
      );
    }
  }

  getActiveProvider(): LLMProvider {
    return this.activeProvider;
  }

  getClient(role: LlmRole): ILlmClient {
    if (role === 'supervisor') {
      if (!this.supervisorClient) {
        this.supervisorClient = LlmClientFactory.createClient(
          this.activeProvider,
          'supervisor',
          this.supervisorModel
        );
      }
      return this.supervisorClient;
    }

    if (!this.translatorClient) {
      this.translatorClient = LlmClientFactory.createClient(
        this.activeProvider,
        'translator',
        this.translatorModel
      );
    }
    return this.translatorClient;
  }

  async callChat(role: LlmRole, params: LlmRoleChatParams): Promise<string> {
    const client = this.getClient(role);
    return await client.chat({
      messages: params.messages,
      temperature: params.temperature,
      jsonMode: params.jsonMode,
      signal: params.signal,
    });
  }

  async getAiCapability(role?: LlmRole): Promise<AiCapability> {
    // If specific role requested, query that client directly
    if (role) {
      return await this.getClient(role).getCapability();
    }

    // Default resolution order: supervisor if enabled, otherwise translator
    if (this.enableSupervisor) {
      const supCap = await this.getClient('supervisor').getCapability();
      if (supCap.hasAi) {
        return supCap;
      }
    }

    return await this.getClient('translator').getCapability();
  }

  // --- Utility & Connection Check methods for popup/options presentation ---

  async checkOllamaConnection(): Promise<{ models: string[] }> {
    const client = new OllamaClient('translator', this.translatorModel, this.storage);
    const res = await client.checkConnection();
    return { models: res.models || [] };
  }

  async fetchOpenRouterModels(forceRefresh: boolean = false): Promise<OpenRouterModelItem[]> {
    const client = new OpenRouterClient('translator', this.translatorModel, this.storage);
    return await client.fetchModels(forceRefresh);
  }

  async checkOpenRouterConnection(): Promise<{
    keyInfo: Record<string, unknown>;
    models: OpenRouterModelItem[];
  }> {
    const client = new OpenRouterClient('translator', this.translatorModel, this.storage);
    const res = await client.checkConnection();
    const models = await client.fetchModels(true);

    return {
      keyInfo: res.keyInfo || {},
      models,
    };
  }
}
