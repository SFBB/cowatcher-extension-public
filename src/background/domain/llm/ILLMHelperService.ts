import {
    CharacterGlossaryMap,
    TermGlossaryMap,
} from '@shared/domain/entities/Glossary';
import { LanguageInfo } from '@shared/domain/value-objects/Language';

export interface ExtractedGlossaryResult {
    characters: CharacterGlossaryMap;
    terms: TermGlossaryMap;
}

export interface ILLMHelperService {
    init(): Promise<void>;

    /**
     * Mode 1: Extract characters and terminology aligned across bilingual source and target reference texts.
     */
    extractGlossaryBilingual(params: {
        sourceText: string;
        targetText: string;
        targetLang: LanguageInfo;
        signal?: AbortSignal;
    }): Promise<ExtractedGlossaryResult>;

    /**
     * Mode 2: Extract characters and terminology from source reference text and translate to target language.
     */
    extractGlossaryAndTranslate(params: {
        sourceText: string;
        targetLang: LanguageInfo;
        signal?: AbortSignal;
    }): Promise<ExtractedGlossaryResult>;

    /**
     * Check if AI capabilities (LLM provider) are configured and available.
     */
    getAiCapability(): Promise<{
        hasAi: boolean;
        provider?: string;
        model?: string;
        isSupervisor: boolean;
    }>;
}
