import { CharacterItem } from '@shared/domain/entities/Translation';
import { PrecedingContextItem } from '@shared/types/Messages';

import { Context } from '@shared/domain/entities/Context';
import { LanguageInfo } from '@shared/domain/value-objects/Language';
import { TranslationProvider } from '@shared/domain/entities/PipelineTypes';

export interface TranslateBatchRequest {
  items: Array<{ id: number; rawText: string }>;
  sourceLang?: LanguageInfo;
  targetLang: LanguageInfo;
  contextItems?: PrecedingContextItem[];
  context: Context | null;
  signal?: AbortSignal;
  movieId?: string;
  mainTitle?: string;
}

export interface TranslateBatchResponse {
  success: boolean;
  results?: Record<number, string>;
  error?: string;
}

export interface ReviewBatchRequest {
  items: Array<{ id: number; rawText: string; transText: string }>;
  sourceLang?: LanguageInfo;
  targetLang: LanguageInfo;
  contextItems?: PrecedingContextItem[];
  context: Context | null;
  signal?: AbortSignal;
  movieId?: string;
  mainTitle?: string;
}

export interface ReviewBatchResponse {
  success: boolean;
  corrections?: Record<number, string>;
  newCharacters?: Record<string, CharacterItem>;
  newTerms?: Record<string, string>;
  error?: string;
}

export interface HealthCheckResult {
  ok: boolean;
  message?: string;
}

export interface ITranslatorService {
  readonly providerId: TranslationProvider;

  /**
   * Translate a batch of subtitle cues to target language
   */
  translateBatch(req: TranslateBatchRequest): Promise<TranslateBatchResponse>;

  /**
   * Supervise and review translated cues
   */
  reviewBatch(req: ReviewBatchRequest): Promise<ReviewBatchResponse>;

  /**
   * Check connection/health of the translation service
   */
  checkHealth(): Promise<HealthCheckResult>;
}
