import { ITranslatorService } from './ITranslatorService';
import { GoogleTranslatorService } from '../../infrastructure/translation/GoogleTranslatorService';
import { LlmTranslatorService } from '../../infrastructure/translation/LlmTranslatorService';
import { TranslationProvider } from '@shared/domain/entities/PipelineTypes';

export class TranslatorRegistry {
  private static services: Map<TranslationProvider, ITranslatorService> = new Map();

  static initialize(): void {
    if (this.services.size > 0) return;
    this.register(new GoogleTranslatorService());
    this.register(new LlmTranslatorService('ollama'));
    this.register(new LlmTranslatorService('openrouter'));
  }

  static register(service: ITranslatorService): void {
    this.services.set(service.providerId, service);
  }

  static getTranslator(providerId: TranslationProvider = 'google'): ITranslatorService {
    this.initialize();
    const service = this.services.get(providerId);
    if (service) {
      return service;
    }
    // Default fallback to google
    return this.services.get('google') || new GoogleTranslatorService();
  }
}
