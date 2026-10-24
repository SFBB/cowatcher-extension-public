/**
 * LLMHelperService
 * Application service implementing ILLMHelperService.
 * Handles AI-powered glossary extraction from bilingual or monolingual reference materials.
 */

import {
    ILLMHelperService,
    ExtractedGlossaryResult,
} from '../../domain/llm/ILLMHelperService';
import { LlmService } from './LlmService';
import {
    CharacterGlossaryMap,
    TermGlossaryMap,
} from '@shared/domain/entities/Glossary';
import { Logger } from '@shared/utils/logger';
import { LanguageInfo } from '@shared/domain/value-objects/Language';
import { AiCapability } from '../../domain/llm/LlmRole';

export class LLMHelperService implements ILLMHelperService {
    private static instance: LLMHelperService | null = null;
    private readonly llmService: LlmService;
    private logger: Logger = new Logger('LLMHelperService');

    private initialized: boolean = false;

    private constructor(llmService: LlmService = LlmService.getInstance()) {
        this.llmService = llmService;
    }

    async init(): Promise<void> {
        if (this.initialized) return;

        await this.llmService.init();

        this.initialized = true;
    }

    static getInstance(llmService?: LlmService): LLMHelperService {
        if (!LLMHelperService.instance) {
            LLMHelperService.instance = new LLMHelperService(llmService);
        }
        return LLMHelperService.instance;
    }

    /**
     * Forwards AI capability check to LlmService.
     */
    async getAiCapability(): Promise<AiCapability> {
        return await this.llmService.getAiCapability();
    }

    /**
     * Mode 1: Bilingual references provided. Extract aligned character names, aliases, and specialized terms.
     */
    async extractGlossaryBilingual(params: {
        sourceText: string;
        targetText: string;
        targetLang: LanguageInfo;
        signal?: AbortSignal;
    }): Promise<ExtractedGlossaryResult> {
        const { sourceText, targetText, targetLang, signal } = params;
        const capability = await this.getAiCapability();
        if (!capability.hasAi) {
            throw new Error(
                'AI Provider (Ollama or OpenRouter) is not configured.',
            );
        }

        const resolvedTargetLang = targetLang.promptName;

        const systemPrompt = `You are an expert bilingual subtitle translation supervisor and named-entity alignment assistant.
Task: Analyze the provided source-language reference and target-language reference texts.
Extract all key characters and specific recurring terms/proper nouns aligned between the two texts into a structured JSON glossary.

Target language for translations: "${resolvedTargetLang}".

Output Requirements:
1. "characters": Map each character's original source name (e.g. Japanese kanji/hiragana or English name) to an object with:
   - "canonical": The official standard translation/spelling in the target language (${resolvedTargetLang}).
   - "aliases": An array of alternate names, nicknames, honorific calls, or maiden names used in the reference text.
2. "terms": Map each recurring specialized term, organization name, fictional concept, or proper noun in the source text to its translated equivalent in ${resolvedTargetLang}.
3. Return ONLY valid JSON in the exact schema below, with no markdown code blocks, preamble, or comments:
{
  "characters": {
    "Original Name": { "canonical": "Target Name", "aliases": ["Nickname 1"] }
  },
  "terms": {
    "Source Term": "Target Term"
  }
}`;

        const userPrompt = `=== SOURCE REFERENCE MATERIAL ===
${sourceText.slice(0, 10000)}

=== TARGET REFERENCE MATERIAL (${resolvedTargetLang}) ===
${targetText.slice(0, 10000)}`;

        const raw = await this.llmService.callChat('supervisor', {
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            temperature: 0.1,
            jsonMode: true,
            signal,
        });

        return this.parseAndSanitizeResult(raw);
    }

    /**
     * Mode 2: Source reference only. Extract character names, aliases, and specialized terms, and translate them into targetLang.
     */
    async extractGlossaryAndTranslate(params: {
        sourceText: string;
        targetLang: LanguageInfo;
        signal?: AbortSignal;
    }): Promise<ExtractedGlossaryResult> {
        const { sourceText, targetLang, signal } = params;
        const capability = await this.getAiCapability();
        if (!capability.hasAi) {
            throw new Error(
                'AI Provider (Ollama or OpenRouter) is not configured.',
            );
        }

        const resolvedTargetLang = targetLang.promptName;

        const systemPrompt = `You are an expert subtitle translation supervisor and named-entity extraction assistant.
Task: Analyze the provided source reference material. Identify all significant characters and recurring proper nouns/terms.
Translate and adapt each extracted entity accurately into the specified target language: "${resolvedTargetLang}".

Output Requirements:
1. "characters": Map each character's original source name to an object with:
   - "canonical": Best official/standard translated name in ${resolvedTargetLang}.
   - "aliases": Array of nicknames, alternate aliases, or informal forms mentioned in the text.
2. "terms": Map each proper noun, fictional concept, organization, or recurring term to its translation in ${resolvedTargetLang}.
3. Return ONLY valid JSON in the exact schema below, with no markdown code fences, preamble, or comments:
{
  "characters": {
    "Original Name": { "canonical": "Target Name", "aliases": ["Nickname"] }
  },
  "terms": {
    "Source Term": "Target Term"
  }
}`;

        const userPrompt = `=== SOURCE REFERENCE MATERIAL ===
${sourceText.slice(0, 12000)}

Target Language: ${resolvedTargetLang}`;

        const raw = await this.llmService.callChat('supervisor', {
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            temperature: 0.2,
            jsonMode: true,
            signal,
        });

        return this.parseAndSanitizeResult(raw);
    }

    private parseAndSanitizeResult(rawText: string): ExtractedGlossaryResult {
        const cleanText = rawText
            .replace(/<think[\s\S]*?<\/think>/gi, '')
            .replace(/<thought[\s\S]*?<\/thought>/gi, '')
            .trim();

        const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            this.logger.warn(
                'Failed to parse JSON from AI Helper extraction output:',
                cleanText.slice(0, 300),
            );
            return { characters: {}, terms: {} };
        }

        try {
            const parsed = JSON.parse(jsonMatch[0]);
            const characters: CharacterGlossaryMap = {};
            const terms: TermGlossaryMap = {};

            if (parsed.characters && typeof parsed.characters === 'object') {
                for (const [name, val] of Object.entries(parsed.characters)) {
                    if (!name.trim()) continue;
                    if (typeof val === 'string') {
                        characters[name.trim()] = {
                            canonical: val.trim(),
                            aliases: [],
                        };
                    } else if (val && typeof val === 'object') {
                        const charObj = val as any;
                        const canonical = (charObj.canonical || name).trim();
                        const aliases = Array.isArray(charObj.aliases)
                            ? charObj.aliases
                                  .map((a: string) => String(a).trim())
                                  .filter(Boolean)
                            : [];
                        characters[name.trim()] = { canonical, aliases };
                    }
                }
            }

            if (parsed.terms && typeof parsed.terms === 'object') {
                for (const [src, tgt] of Object.entries(parsed.terms)) {
                    if (src.trim() && typeof tgt === 'string' && tgt.trim()) {
                        terms[src.trim()] = tgt.trim();
                    }
                }
            }

            return { characters, terms };
        } catch (err: any) {
            this.logger.error(
                'Error parsing JSON from LLM Helper:',
                err?.message || String(err),
            );
            return { characters: {}, terms: {} };
        }
    }
}
