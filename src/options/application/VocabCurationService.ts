import {
    EpisodeVocabData,
    VocabWordItem,
} from '@shared/domain/entities/Vocabulary';
import { OptionsMessageService } from './OptionsMessageService';
import { IBrowserStorage } from '@shared/infrastructure/storage/IBrowserStorage';
import { BrowserStorageFactory } from '@shared/infrastructure/storage/BrowserStorageFactory';
import { NCW_STORAGE_KEYS } from '@shared/domain/constants/StorageKeys';

const CUSTOM_PROMPT_STORAGE_KEY = 'ncw_curation_custom_prompt';

/**
 * Application service coordinating vocabulary curation, language snapshot resolution,
 * supervisor-model enrichment with custom prompt injection, and storage persistence.
 */
export class VocabCurationService {
    constructor(
        private readonly messageService: OptionsMessageService = OptionsMessageService.getInstance(),
        private readonly storage: IBrowserStorage = BrowserStorageFactory.getStorage(),
    ) {}

    /**
     * Resolves the immutable language snapshot for a word, falling back to the episode snapshot.
     */
    resolveWordLanguages(
        word: VocabWordItem,
        episode: EpisodeVocabData,
    ): { sourceLang: string; targetLang: string } {
        return {
            sourceLang: word.sourceLang || episode.sourceLanguage || 'ja',
            targetLang: word.targetLang || episode.targetLanguage || 'zh-CN',
        };
    }

    /**
     * Enriches a single vocabulary item using the supervisor model (with fallback to translator model),
     * incorporating any user-injected custom prompt instructions.
     */
    async enrichWord(
        word: VocabWordItem,
        episode: EpisodeVocabData,
        customPrompt?: string,
    ): Promise<VocabWordItem> {
        const { sourceLang, targetLang } = this.resolveWordLanguages(
            word,
            episode,
        );

        const res = await this.messageService.lookupWordDefinition({
            word: word.word,
            contextSentence: word.sentence,
            contextTranslation: word.sentenceTranslation,
            sourceLang,
            targetLang,
            customPrompt: customPrompt?.trim() || undefined,
            preferredRole: 'supervisor',
        });

        if (!res) {
            return word;
        }

        return {
            ...word,
            pos: res.pos || word.pos,
            phonetic: res.reading || word.phonetic,
            meaning: res.meaning || word.meaning,
            sentence: res.exampleSentence || word.sentence,
            sentenceTranslation:
                res.exampleTranslation || word.sentenceTranslation,
            sourceLang,
            targetLang,
        };
    }

    /**
     * Persists the curated words list back to browser storage for the given episode.
     */
    async saveCuratedEpisode(
        movieId: string,
        episode: EpisodeVocabData,
        words: VocabWordItem[],
    ): Promise<void> {
        const storageKey = `${NCW_STORAGE_KEYS.VOCAB_PREFIX}${movieId}`;
        const updatedData: EpisodeVocabData = {
            ...episode,
            updatedAt: Date.now(),
            totalWords: words.length,
            words,
        };

        await this.storage.set({ [storageKey]: updatedData });
    }

    /**
     * Loads the last-used custom prompt template from storage.
     */
    async getSavedCustomPrompt(): Promise<string> {
        try {
            const data = await this.storage.get<string>(
                CUSTOM_PROMPT_STORAGE_KEY,
            );
            return (data && data[CUSTOM_PROMPT_STORAGE_KEY]) || '';
        } catch {
            return '';
        }
    }

    /**
     * Saves the custom prompt template to storage for reuse.
     */
    async saveCustomPrompt(prompt: string): Promise<void> {
        try {
            await this.storage.set({ [CUSTOM_PROMPT_STORAGE_KEY]: prompt });
        } catch {
            // Ignore storage errors
        }
    }
}
