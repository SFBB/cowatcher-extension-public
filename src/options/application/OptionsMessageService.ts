/**
 * OptionsMessageService
 * Strongly typed message service for the options UI.
 */

import { ContentBackgroundBus } from '@shared/infrastructure/bus/ContentBackgroundBus';
import { AiSubState } from '@shared/domain/entities/AiSubState';
import { ContextDTO } from '@shared/domain/entities/Context';
import { OpenRouterModelItem } from '@shared/types/Messages';
import { StreamingPlatformId } from '@shared/domain/constants/StreamingPlatforms';
import { LanguageInfo } from '@shared/domain/value-objects/Language';
import NCW_CONSTANTS from '@shared/utils/constants';

export class OptionsMessageService {
  private static instance: OptionsMessageService | null = null;

  static getInstance(): OptionsMessageService {
    if (!OptionsMessageService.instance) {
      OptionsMessageService.instance = new OptionsMessageService();
    }
    return OptionsMessageService.instance;
  }

  // --- AI Sub State ---

  async getAiSubState(): Promise<AiSubState | null> {
    const res = await ContentBackgroundBus.send(
      NCW_CONSTANTS.MESSAGE_TYPES.GET_AI_SUB_STATE,
      undefined
    );
    return res.success && res.state ? new AiSubState(res.state) : null;
  }

  async setAiSubEnabled(
    enabled: boolean,
    platform?: StreamingPlatformId
  ): Promise<AiSubState | null> {
    const res = await ContentBackgroundBus.send(NCW_CONSTANTS.MESSAGE_TYPES.SET_AI_SUB_ENABLED, {
      enabled,
      platform,
    });
    return res.success && res.state ? new AiSubState(res.state) : null;
  }

  // --- Glossary ---

  async getGlossaryContext(): Promise<ContextDTO | null> {
    const res = await ContentBackgroundBus.send(NCW_CONSTANTS.MESSAGE_TYPES.GET_CONTEXT, {});
    return res.success ? res.context : null;
  }

  async updateTerm(
    showId: string,
    targetLanguage: LanguageInfo,
    key: string,
    value: string
  ): Promise<ContextDTO | null> {
    const res = await ContentBackgroundBus.send(NCW_CONSTANTS.MESSAGE_TYPES.UPDATE_TERM, {
      showId,
      targetLanguage,
      key,
      value,
    });
    return res.success ? res.context : null;
  }

  async deleteTerm(
    shwoId: string,
    targetLanguage: LanguageInfo,
    key: string
  ): Promise<ContextDTO | null> {
    const res = await ContentBackgroundBus.send(NCW_CONSTANTS.MESSAGE_TYPES.DELETE_TERM, {
      showId: shwoId,
      targetLanguage: targetLanguage,
      key: key,
    });
    return res.success ? res.context : null;
  }

  async resetGlossaryContext(
    showId: string,
    targetLanguage: LanguageInfo
  ): Promise<ContextDTO | null> {
    const res = await ContentBackgroundBus.send(NCW_CONSTANTS.MESSAGE_TYPES.RESET_CONTEXT, {
      showId: showId,
      targetLanguage: targetLanguage,
    });
    return res.success ? res.context : null;
  }

  // --- Vocabulary ---

  async resetVocabData(movieId: string): Promise<boolean> {
    const res = await ContentBackgroundBus.send(NCW_CONSTANTS.MESSAGE_TYPES.RESET_VOCAB_DATA, {
      movieId,
    });
    return res.success;
  }

  onGlossaryChanged(callback: (context: ContextDTO) => void): () => void {
    return ContentBackgroundBus.onMessage(
      NCW_CONSTANTS.MESSAGE_TYPES.PUSH_GLOSSARY_CHANGED,
      (payload) => {
        if (payload && payload.context) {
          callback(payload.context);
        }
      }
    );
  }

  // --- Provider Checks ---

  async checkOllama(): Promise<{
    success: boolean;
    models?: Array<{ name: string }>;
    error?: string;
  }> {
    const res = await ContentBackgroundBus.send(
      NCW_CONSTANTS.MESSAGE_TYPES.CHECK_OLLAMA,
      undefined
    );
    return { success: res.success, models: res.data, error: res.error };
  }

  async checkOpenRouter() {
    return await ContentBackgroundBus.send(NCW_CONSTANTS.MESSAGE_TYPES.CHECK_OPENROUTER, undefined);
  }

  async fetchOpenRouterModels(): Promise<{
    success: boolean;
    models?: OpenRouterModelItem[];
    error?: string;
  }> {
    const res = await ContentBackgroundBus.send(
      NCW_CONSTANTS.MESSAGE_TYPES.FETCH_OPENROUTER_MODELS,
      undefined
    );
    return { success: res.success, models: res.models, error: res.error };
  }

  // --- Subtitle Cache Management ---

  async markCuesStale(params: {
    trackHash?: string;
    cacheKey?: string;
    startTime: number;
    endTime: number;
  }): Promise<{ success: boolean; invalidatedCount: number; error?: string }> {
    return await ContentBackgroundBus.send(NCW_CONSTANTS.MESSAGE_TYPES.MARK_CUES_STALE, params);
  }
}
