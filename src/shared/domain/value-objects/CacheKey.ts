import { Language } from './Language';

export class CacheKey {
  readonly value: string;

  private constructor(value: string) {
    this.value = value;
  }

  static create(params: {
    trackHash: string;
    targetLanguage: string;
    provider: string;
    translationModel: string;
  }): CacheKey {
    const cleanHash = (params.trackHash || 'unknown').trim();
    const lang = Language.resolve(params.targetLanguage);
    const cleanLang = lang.code.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    const cleanProvider = (params.provider || 'ollama').trim().toLowerCase();
    const cleanModel = (params.translationModel || 'default')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '_');
    return new CacheKey(`ncw_sub_${cleanHash}_${cleanLang}_${cleanProvider}_${cleanModel}`);
  }

  static fromString(key: string): CacheKey {
    return new CacheKey(key);
  }

  toString(): string {
    return this.value;
  }
}
