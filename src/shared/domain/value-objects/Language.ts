/**
 * Language Domain Value Object
 * Defines standard supported languages, ISO/BCP-47 codes, UI display labels,
 * Google Translate API codes, and LLM prompt target descriptions.
 */

export interface LanguageInfo {
    readonly code: string; // Canonical code (e.g. 'zh-CN', 'en')
    readonly iso639_1: string; // 2-letter ISO 639-1 base code (e.g. 'zh', 'en')
    readonly bcp47Codes: readonly string[]; // All recognized BCP-47 variants & aliases (e.g. ['zh-Hans', 'zh-CN', 'zh-SG', 'zh'])
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
            iso639_1: 'zh',
            bcp47Codes: ['zh-Hans', 'zh-CN', 'zh-SG', 'zh'],
            name: 'Simplified Chinese',
            nativeName: '简体中文',
            label: '简体中文 (Simplified Chinese)',
            googleCode: 'zh-CN',
            promptName: 'Simplified Chinese (简体中文)',
        },
        {
            code: 'zh-TW',
            iso639_1: 'zh',
            bcp47Codes: ['zh-Hant', 'zh-TW', 'zh-HK', 'zh-MO'],
            name: 'Traditional Chinese',
            nativeName: '繁體中文',
            label: '繁體中文 (Traditional Chinese)',
            googleCode: 'zh-TW',
            promptName: 'Traditional Chinese (繁體中文)',
        },
        {
            code: 'en',
            iso639_1: 'en',
            bcp47Codes: ['en', 'en-US', 'en-GB', 'en-CA', 'en-AU'],
            name: 'English',
            nativeName: 'English',
            label: 'English',
            googleCode: 'en',
            promptName: 'English',
        },
        {
            code: 'ja',
            iso639_1: 'ja',
            bcp47Codes: ['ja', 'ja-JP'],
            name: 'Japanese',
            nativeName: '日本語',
            label: '日本語 (Japanese)',
            googleCode: 'ja',
            promptName: 'Japanese (日本語)',
        },
        {
            code: 'ko',
            iso639_1: 'ko',
            bcp47Codes: ['ko', 'ko-KR'],
            name: 'Korean',
            nativeName: '한국어',
            label: '한국어 (Korean)',
            googleCode: 'ko',
            promptName: 'Korean (한국어)',
        },
        {
            code: 'es',
            iso639_1: 'es',
            bcp47Codes: ['es', 'es-ES', 'es-419', 'es-MX', 'es-US', 'es-AR'],
            name: 'Spanish',
            nativeName: 'Español',
            label: 'Español (Spanish)',
            googleCode: 'es',
            promptName: 'Spanish (Español)',
        },
        {
            code: 'fr',
            iso639_1: 'fr',
            bcp47Codes: ['fr', 'fr-FR', 'fr-CA', 'fr-BE', 'fr-CH'],
            name: 'French',
            nativeName: 'Français',
            label: 'Français (French)',
            googleCode: 'fr',
            promptName: 'French (Français)',
        },
        {
            code: 'de',
            iso639_1: 'de',
            bcp47Codes: ['de', 'de-DE', 'de-AT', 'de-CH'],
            name: 'German',
            nativeName: 'Deutsch',
            label: 'Deutsch (German)',
            googleCode: 'de',
            promptName: 'German (Deutsch)',
        },
        {
            code: 'it',
            iso639_1: 'it',
            bcp47Codes: ['it', 'it-IT', 'it-CH'],
            name: 'Italian',
            nativeName: 'Italiano',
            label: 'Italiano (Italian)',
            googleCode: 'it',
            promptName: 'Italian (Italiano)',
        },
        {
            code: 'pt',
            iso639_1: 'pt',
            bcp47Codes: ['pt', 'pt-BR', 'pt-PT'],
            name: 'Portuguese',
            nativeName: 'Português',
            label: 'Português (Portuguese)',
            googleCode: 'pt',
            promptName: 'Portuguese (Português)',
        },
        {
            code: 'ru',
            iso639_1: 'ru',
            bcp47Codes: ['ru', 'ru-RU'],
            name: 'Russian',
            nativeName: 'Русский',
            label: 'Русский (Russian)',
            googleCode: 'ru',
            promptName: 'Russian (Русский)',
        },
        {
            code: 'vi',
            iso639_1: 'vi',
            bcp47Codes: ['vi', 'vi-VN'],
            name: 'Vietnamese',
            nativeName: 'Tiếng Việt',
            label: 'Tiếng Việt (Vietnamese)',
            googleCode: 'vi',
            promptName: 'Vietnamese (Tiếng Việt)',
        },
        {
            code: 'id',
            iso639_1: 'id',
            bcp47Codes: ['id', 'id-ID'],
            name: 'Indonesian',
            nativeName: 'Bahasa Indonesia',
            label: 'Bahasa Indonesia',
            googleCode: 'id',
            promptName: 'Indonesian (Bahasa Indonesia)',
        },
        {
            code: 'th',
            iso639_1: 'th',
            bcp47Codes: ['th', 'th-TH'],
            name: 'Thai',
            nativeName: 'ภาษาไทย',
            label: 'ภาษาไทย (Thai)',
            googleCode: 'th',
            promptName: 'Thai (ภาษาไทย)',
        },
        {
            code: 'ar',
            iso639_1: 'ar',
            bcp47Codes: ['ar', 'ar-SA', 'ar-EG', 'ar-AE'],
            name: 'Arabic',
            nativeName: 'العربية',
            label: 'العربية (Arabic)',
            googleCode: 'ar',
            promptName: 'Arabic (العربية)',
        },
    ];

    static readonly DEFAULT: LanguageInfo = Language.LANGUAGES[0];

    static getAll(): LanguageInfo[] {
        return [...Language.LANGUAGES];
    }

    static get(code?: string | LanguageInfo): LanguageInfo | undefined {
        if (!code) return undefined;
        if (typeof code === 'object' && code !== null && 'code' in code) {
            return code as LanguageInfo;
        }
        return Language.LANGUAGES.find(
            (l) => l.code.toLowerCase() === code.trim().toLowerCase(),
        );
    }

    static findByBcp47(bcpTag: string): LanguageInfo | undefined {
        if (!bcpTag) return undefined;
        const clean = bcpTag.trim().toLowerCase();
        return Language.LANGUAGES.find((l) =>
            l.bcp47Codes.some((alias) => alias.toLowerCase() === clean),
        );
    }

    static matches(
        a?: string | LanguageInfo | null,
        b?: string | LanguageInfo | null,
    ): boolean {
        if (!a || !b) return false;
        const infoA = Language.resolve(a);
        const infoB = Language.resolve(b);

        if (infoA.code.toLowerCase() === infoB.code.toLowerCase()) {
            return true;
        }

        const strA =
            typeof a === 'string'
                ? a.trim().toLowerCase()
                : infoA.code.toLowerCase();
        const strB =
            typeof b === 'string'
                ? b.trim().toLowerCase()
                : infoB.code.toLowerCase();

        return (
            infoA.bcp47Codes.some((tag) => tag.toLowerCase() === strB) ||
            infoB.bcp47Codes.some((tag) => tag.toLowerCase() === strA)
        );
    }

    static resolve(input?: string | LanguageInfo | null): LanguageInfo {
        if (!input) return Language.DEFAULT;
        const fromObj = Language.resolveFromObject(input);
        if (fromObj) return fromObj;

        const rawStr = Language.extractRawString(input);
        if (!rawStr) return Language.DEFAULT;

        const clean = rawStr.trim().toLowerCase();
        const matchedBcp = Language.findByBcp47(clean);
        if (matchedBcp) return matchedBcp;

        const matchedExact = Language.findExactMatch(clean);
        if (matchedExact) return matchedExact;

        const matchedHeuristic = Language.findHeuristicMatch(clean);
        if (matchedHeuristic) return matchedHeuristic;

        return Language.createCustomLanguage(rawStr.trim());
    }

    private static resolveFromObject(input: unknown): LanguageInfo | null {
        if (typeof input !== 'object' || input === null) return null;
        const rec = input as Record<string, unknown>;

        if (
            typeof rec.code === 'string' &&
            typeof rec.promptName === 'string' &&
            Array.isArray(rec.bcp47Codes)
        ) {
            return input as LanguageInfo;
        }
        if (typeof rec.code === 'string') {
            const found = Language.get(rec.code);
            if (found) return found;
        }
        if (rec.targetLanguage) {
            return Language.resolve(
                rec.targetLanguage as string | LanguageInfo,
            );
        }
        return null;
    }

    private static extractRawString(input: unknown): string {
        if (typeof input === 'string') return input;
        if (typeof input !== 'object' || input === null) return '';
        const rec = input as Record<string, unknown>;
        if (typeof rec.code === 'string') return rec.code;
        if (typeof rec.name === 'string') return rec.name;
        if (typeof rec.label === 'string') return rec.label;
        return '';
    }

    private static findExactMatch(clean: string): LanguageInfo | null {
        for (const lang of Language.LANGUAGES) {
            if (
                lang.code.toLowerCase() === clean ||
                lang.iso639_1.toLowerCase() === clean ||
                lang.name.toLowerCase() === clean ||
                lang.nativeName.toLowerCase() === clean ||
                lang.label.toLowerCase() === clean
            ) {
                return lang;
            }
        }
        return null;
    }

    private static readonly HEURISTIC_PATTERNS: Array<{
        code: string;
        keywords: readonly string[];
    }> = [
        { code: 'zh-CN', keywords: ['简', 'zh', 'simplified'] },
        { code: 'zh-TW', keywords: ['繁', 'traditional'] },
        { code: 'en', keywords: ['english', '英'] },
        { code: 'ja', keywords: ['japan', '日本', '日文'] },
        { code: 'ko', keywords: ['korean', '韩', '한국'] },
        { code: 'es', keywords: ['span', 'español', '西班'] },
        { code: 'fr', keywords: ['french', 'français', '法'] },
        { code: 'de', keywords: ['german', 'deutsch', '德'] },
        { code: 'ru', keywords: ['russian', 'русский', '俄'] },
        { code: 'pt', keywords: ['portug', '葡萄牙'] },
        { code: 'it', keywords: ['italian', '意大'] },
        { code: 'vi', keywords: ['vietnam', '越'] },
        { code: 'id', keywords: ['indonesia', '印尼'] },
        { code: 'th', keywords: ['thai', '泰'] },
        { code: 'ar', keywords: ['arab', '阿拉'] },
    ];

    private static findHeuristicMatch(clean: string): LanguageInfo | null {
        for (const item of Language.HEURISTIC_PATTERNS) {
            if (item.keywords.some((kw) => clean.includes(kw))) {
                return (
                    Language.LANGUAGES.find((l) => l.code === item.code) || null
                );
            }
        }
        return null;
    }

    private static createCustomLanguage(trimmed: string): LanguageInfo {
        const iso = trimmed.slice(0, 2).toLowerCase();
        return {
            code: trimmed,
            iso639_1: iso,
            bcp47Codes: [trimmed],
            name: trimmed,
            nativeName: trimmed,
            label: trimmed,
            googleCode: trimmed.toLowerCase(),
            promptName: trimmed,
        };
    }
}
