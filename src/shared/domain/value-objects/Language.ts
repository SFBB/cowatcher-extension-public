/**
 * Language Domain Value Object
 * Defines standard supported languages, ISO/BCP-47 codes, UI display labels,
 * Google Translate API codes, and LLM prompt target descriptions.
 */

export interface LanguageInfo {
  readonly code: string; // BCP-47 / ISO standard code (e.g. 'zh-CN', 'en')
  readonly name: string; // Canonical English name (e.g. 'Simplified Chinese')
  readonly nativeName: string; // Native localized name (e.g. '简体中文')
  readonly label: string; // Display label for UI dropdowns
  readonly googleCode: string; // Code accepted by Google Translate Web API
  readonly promptName: string; // Detailed name for LLM system prompts
}

export class Language {
  private static readonly LANGUAGES: LanguageInfo[] = [
    {
      code: 'zh-CN',
      name: 'Simplified Chinese',
      nativeName: '简体中文',
      label: '简体中文 (Simplified Chinese)',
      googleCode: 'zh-CN',
      promptName: 'Simplified Chinese (简体中文)',
    },
    {
      code: 'zh-TW',
      name: 'Traditional Chinese',
      nativeName: '繁體中文',
      label: '繁體中文 (Traditional Chinese)',
      googleCode: 'zh-TW',
      promptName: 'Traditional Chinese (繁體中文)',
    },
    {
      code: 'en',
      name: 'English',
      nativeName: 'English',
      label: 'English',
      googleCode: 'en',
      promptName: 'English',
    },
    {
      code: 'ja',
      name: 'Japanese',
      nativeName: '日本語',
      label: '日本語 (Japanese)',
      googleCode: 'ja',
      promptName: 'Japanese (日本語)',
    },
    {
      code: 'ko',
      name: 'Korean',
      nativeName: '한국어',
      label: '한국어 (Korean)',
      googleCode: 'ko',
      promptName: 'Korean (한국어)',
    },
    {
      code: 'es',
      name: 'Spanish',
      nativeName: 'Español',
      label: 'Español (Spanish)',
      googleCode: 'es',
      promptName: 'Spanish (Español)',
    },
    {
      code: 'fr',
      name: 'French',
      nativeName: 'Français',
      label: 'Français (French)',
      googleCode: 'fr',
      promptName: 'French (Français)',
    },
    {
      code: 'de',
      name: 'German',
      nativeName: 'Deutsch',
      label: 'Deutsch (German)',
      googleCode: 'de',
      promptName: 'German (Deutsch)',
    },
    {
      code: 'it',
      name: 'Italian',
      nativeName: 'Italiano',
      label: 'Italiano (Italian)',
      googleCode: 'it',
      promptName: 'Italian (Italiano)',
    },
    {
      code: 'pt',
      name: 'Portuguese',
      nativeName: 'Português',
      label: 'Português (Portuguese)',
      googleCode: 'pt',
      promptName: 'Portuguese (Português)',
    },
    {
      code: 'ru',
      name: 'Russian',
      nativeName: 'Русский',
      label: 'Русский (Russian)',
      googleCode: 'ru',
      promptName: 'Russian (Русский)',
    },
    {
      code: 'vi',
      name: 'Vietnamese',
      nativeName: 'Tiếng Việt',
      label: 'Tiếng Việt (Vietnamese)',
      googleCode: 'vi',
      promptName: 'Vietnamese (Tiếng Việt)',
    },
    {
      code: 'id',
      name: 'Indonesian',
      nativeName: 'Bahasa Indonesia',
      label: 'Bahasa Indonesia',
      googleCode: 'id',
      promptName: 'Indonesian (Bahasa Indonesia)',
    },
    {
      code: 'th',
      name: 'Thai',
      nativeName: 'ภาษาไทย',
      label: 'ภาษาไทย (Thai)',
      googleCode: 'th',
      promptName: 'Thai (ภาษาไทย)',
    },
    {
      code: 'ar',
      name: 'Arabic',
      nativeName: 'العربية',
      label: 'العربية (Arabic)',
      googleCode: 'ar',
      promptName: 'Arabic (العربية)',
    },
  ];

  static readonly DEFAULT: LanguageInfo = Language.LANGUAGES[0]; // Simplified Chinese by default

  /**
   * Returns all standard supported languages.
   */
  static getAll(): LanguageInfo[] {
    return [...Language.LANGUAGES];
  }

  /**
   * Finds a language by its exact canonical code, or undefined.
   */
  static get(code?: string | LanguageInfo): LanguageInfo | undefined {
    if (!code) return undefined;
    if (typeof code === 'object' && code !== null && 'code' in code) {
      return code as LanguageInfo;
    }
    return Language.LANGUAGES.find((l) => l.code.toLowerCase() === code.trim().toLowerCase());
  }

  /**
   * Resolves a language string (BCP-47 code, native name, English name, or alias)
   * to a canonical LanguageInfo object.
   */
  static resolve(input?: string | LanguageInfo | any): LanguageInfo {
    if (!input) {
      return Language.DEFAULT;
    }
    if (typeof input === 'object' && input !== null) {
      if (
        'code' in input &&
        typeof input.code === 'string' &&
        'promptName' in input &&
        typeof input.promptName === 'string'
      ) {
        return input as LanguageInfo;
      }
      if ('code' in input && typeof input.code === 'string') {
        const found = Language.get(input.code);
        if (found) return found;
      }
      if ('targetLanguage' in input && input.targetLanguage) {
        return Language.resolve(input.targetLanguage);
      }
    }

    const rawStr =
      typeof input === 'string'
        ? input
        : typeof input?.code === 'string'
          ? input.code
          : typeof input?.name === 'string'
            ? input.name
            : typeof input?.label === 'string'
              ? input.label
              : '';

    if (!rawStr || typeof rawStr !== 'string') {
      return Language.DEFAULT;
    }

    const clean = rawStr.trim().toLowerCase();

    // 1. Direct code or name match
    for (const lang of Language.LANGUAGES) {
      if (
        lang.code.toLowerCase() === clean ||
        lang.name.toLowerCase() === clean ||
        lang.nativeName.toLowerCase() === clean ||
        lang.label.toLowerCase() === clean
      ) {
        return lang;
      }
    }

    // 2. Fuzzy heuristic matching for common localized patterns
    if (
      clean.includes('简') ||
      clean === 'zh' ||
      clean === 'zh-cn' ||
      clean === 'chinese' ||
      clean.includes('simplified')
    ) {
      return Language.LANGUAGES.find((l) => l.code === 'zh-CN')!;
    }
    if (clean.includes('繁') || clean === 'zh-tw' || clean.includes('traditional')) {
      return Language.LANGUAGES.find((l) => l.code === 'zh-TW')!;
    }
    if (clean === 'en' || clean.includes('english') || clean.includes('英')) {
      return Language.LANGUAGES.find((l) => l.code === 'en')!;
    }
    if (
      clean === 'ja' ||
      clean.includes('japan') ||
      clean.includes('日本') ||
      clean.includes('日文')
    ) {
      return Language.LANGUAGES.find((l) => l.code === 'ja')!;
    }
    if (
      clean === 'ko' ||
      clean.includes('korean') ||
      clean.includes('韩') ||
      clean.includes('韓') ||
      clean.includes('한국')
    ) {
      return Language.LANGUAGES.find((l) => l.code === 'ko')!;
    }
    if (
      clean === 'es' ||
      clean.includes('span') ||
      clean.includes('español') ||
      clean.includes('西班')
    ) {
      return Language.LANGUAGES.find((l) => l.code === 'es')!;
    }
    if (
      clean === 'fr' ||
      clean.includes('french') ||
      clean.includes('français') ||
      clean.includes('法')
    ) {
      return Language.LANGUAGES.find((l) => l.code === 'fr')!;
    }
    if (
      clean === 'de' ||
      clean.includes('german') ||
      clean.includes('deutsch') ||
      clean.includes('德')
    ) {
      return Language.LANGUAGES.find((l) => l.code === 'de')!;
    }
    if (
      clean === 'ru' ||
      clean.includes('russian') ||
      clean.includes('русский') ||
      clean.includes('俄')
    ) {
      return Language.LANGUAGES.find((l) => l.code === 'ru')!;
    }
    if (
      clean === 'pt' ||
      clean.includes('portug') ||
      clean.includes('português') ||
      clean.includes('葡萄牙')
    ) {
      return Language.LANGUAGES.find((l) => l.code === 'pt')!;
    }
    if (
      clean === 'it' ||
      clean.includes('italian') ||
      clean.includes('italiano') ||
      clean.includes('意大')
    ) {
      return Language.LANGUAGES.find((l) => l.code === 'it')!;
    }
    if (
      clean === 'vi' ||
      clean.includes('vietnam') ||
      clean.includes('tiếng việt') ||
      clean.includes('越')
    ) {
      return Language.LANGUAGES.find((l) => l.code === 'vi')!;
    }
    if (clean === 'id' || clean.includes('indonesia') || clean.includes('印尼')) {
      return Language.LANGUAGES.find((l) => l.code === 'id')!;
    }
    if (clean === 'th' || clean.includes('thai') || clean.includes('ไทย') || clean.includes('泰')) {
      return Language.LANGUAGES.find((l) => l.code === 'th')!;
    }
    if (
      clean === 'ar' ||
      clean.includes('arab') ||
      clean.includes('العربية') ||
      clean.includes('阿拉')
    ) {
      return Language.LANGUAGES.find((l) => l.code === 'ar')!;
    }

    // 3. Fallback for unlisted custom language
    const trimmed = rawStr.trim();
    if (!trimmed) {
      return Language.DEFAULT;
    }
    return {
      code: trimmed,
      name: trimmed,
      nativeName: trimmed,
      label: trimmed,
      googleCode: trimmed.toLowerCase(),
      promptName: trimmed,
    };
  }
}
