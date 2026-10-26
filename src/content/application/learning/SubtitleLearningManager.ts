import { IStreamingAdapter } from '../../domain/adapters/IStreamingAdapter';
import { ContentMessageService } from '../services/ContentMessageService';
import {
    SubtitleToken,
    LearningCueItem,
    WordLookupResult,
} from '@shared/domain/entities/SubtitleLearning';
import { VocabWordItem } from '@shared/domain/entities/Vocabulary';
import { ExtensionSettings } from '@shared/domain/constants/SettingsDefaults';
import { SubtitleLearningPopover } from '../../presentation/SubtitleLearningPopover';
import { Logger } from '@shared/utils/logger';

interface SegmentData {
    segment: string;
    index: number;
    isWordLike?: boolean;
}

interface IntlSegmenterInstance {
    segment(input: string): Iterable<SegmentData>;
}

interface IntlWithSegmenter {
    Segmenter: new (
        locale: string,
        options?: { granularity: 'grapheme' | 'word' | 'sentence' },
    ) => IntlSegmenterInstance;
}

export class SubtitleLearningManager {
    private readonly adapter: IStreamingAdapter;
    private readonly messageService: ContentMessageService;
    private readonly popover: SubtitleLearningPopover;
    private readonly logger: Logger = new Logger('SubtitleLearningManager');

    private settings: ExtensionSettings;
    private currentMovieId: string | null = null;
    private currentShowTitle: string = '';
    private currentSourceLang: string = 'ja';
    private currentTargetLang: string = 'zh-CN';

    private userVocabWords = new Set<string>();
    private learningCueCache = new Map<number, LearningCueItem>();
    private wordLookupCache = new Map<string, WordLookupResult>();
    private pausedByLearning: boolean = false;
    private segmenterCache = new Map<string, IntlSegmenterInstance>();

    constructor(
        adapter: IStreamingAdapter,
        messageService: ContentMessageService,
        settings: ExtensionSettings,
    ) {
        this.adapter = adapter;
        this.messageService = messageService;
        this.settings = settings;
        this.popover = new SubtitleLearningPopover();

        // Listen for vocabulary updates to stay synchronized
        this.messageService.onVocabChanged((data) => {
            if (data && Array.isArray(data.words)) {
                this.syncUserVocabWords(data.words);
            }
        });
    }

    updateSettings(settings: ExtensionSettings): void {
        this.settings = settings;
        if (!settings.enableSubtitleLearning && this.popover.isVisible) {
            this.popover.hide();
        }
    }

    get isEnabled(): boolean {
        return Boolean(this.settings.enableSubtitleLearning);
    }

    onShowContext(
        movieId: string,
        showTitle?: string,
        sourceLang?: string,
        targetLang?: string,
    ): void {
        this.currentMovieId = movieId;
        this.currentShowTitle = showTitle || this.currentShowTitle;
        if (sourceLang) this.currentSourceLang = sourceLang;
        if (targetLang) this.currentTargetLang = targetLang;

        this.learningCueCache.clear();
        this.userVocabWords.clear();

        if (movieId) {
            this.messageService.getVocabData(movieId).then((data) => {
                if (data && Array.isArray(data.words)) {
                    this.syncUserVocabWords(data.words);
                }
            });
        }
    }

    private syncUserVocabWords(words: VocabWordItem[]): void {
        this.userVocabWords.clear();
        for (const w of words) {
            if (w.source === 'user' && w.word) {
                this.userVocabWords.add(w.word.toLowerCase().trim());
            }
        }
    }

    /**
     * Tokenize original subtitle cue text into interactive tokens.
     * Does NOT mutate or touch the underlying SubtitleCue or raw cues.
     */
    getOrCreateLearningCue(
        cueId: number,
        rawText: string,
        translatedText?: string,
    ): LearningCueItem {
        if (this.learningCueCache.has(cueId)) {
            const cached = this.learningCueCache.get(cueId)!;
            // Refresh user-marked state in case words were starred since last tokenization
            for (const t of cached.tokens) {
                t.isUserMarked = this.userVocabWords.has(
                    t.text.toLowerCase().trim(),
                );
            }
            return cached;
        }

        const tokens = this.tokenizeText(rawText, cueId);
        const learningCue: LearningCueItem = {
            cueId,
            originalText: rawText,
            translatedText,
            tokens,
        };

        this.learningCueCache.set(cueId, learningCue);
        return learningCue;
    }

    /**
     * Fast, zero-dependency tokenization using modern browser native Intl.Segmenter.
     */
    private tokenizeText(text: string, cueId: number): SubtitleToken[] {
        if (!text || typeof text !== 'string') return [];

        const lang = this.currentSourceLang || 'ja';
        let segmenter = this.segmenterCache.get(lang);
        if (!segmenter) {
            try {
                if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
                    const intlWithSeg = Intl as unknown as IntlWithSegmenter;
                    segmenter = new intlWithSeg.Segmenter(lang, {
                        granularity: 'word',
                    });
                    this.segmenterCache.set(lang, segmenter);
                }
            } catch {
                // Fallback below
            }
        }

        const tokens: SubtitleToken[] = [];
        if (segmenter) {
            try {
                const segments = Array.from(segmenter.segment(text));
                let tIdx = 0;
                for (const seg of segments) {
                    const segText = seg.segment || '';
                    if (!segText) continue;
                    const isWordLike = Boolean(seg.isWordLike);
                    const normalized = segText.toLowerCase().trim();
                    tokens.push({
                        id: `c${cueId}_t${tIdx++}`,
                        text: segText,
                        isWordLike,
                        index: seg.index || 0,
                        isUserMarked: isWordLike
                            ? this.userVocabWords.has(normalized)
                            : false,
                    });
                }
                return tokens;
            } catch (err) {
                this.logger.warn(
                    'Tokenize',
                    'Intl.Segmenter failed, using regex fallback:',
                    err,
                );
            }
        }

        // Fallback word tokenization with regex
        const regex =
            /([\u3040-\u30ff\u4e00-\u9fa5\w]+|[^\s\w\u3040-\u30ff\u4e00-\u9fa5]+|\s+)/g;
        let match: RegExpExecArray | null;
        let tIdx = 0;
        while ((match = regex.exec(text)) !== null) {
            const segText = match[0];
            const isWordLike = /[\u3040-\u30ff\u4e00-\u9fa5\w]/.test(segText);
            const normalized = segText.toLowerCase().trim();
            tokens.push({
                id: `c${cueId}_t${tIdx++}`,
                text: segText,
                isWordLike,
                index: match.index,
                isUserMarked: isWordLike
                    ? this.userVocabWords.has(normalized)
                    : false,
            });
        }

        return tokens;
    }

    /**
     * Handle user Left Click on a subtitle token:
     * 1. Pauses playback using platform adapter.
     * 2. Opens dictionary/learning popover card.
     * 3. Triggers definition lookup.
     */
    handleTokenClick(
        token: SubtitleToken,
        cueText: string,
        translatedText: string | undefined,
        tokenEl: HTMLElement,
        container: HTMLElement,
    ): void {
        if (!token.isWordLike || !token.text.trim()) return;

        const autoPause = this.settings.autoPauseOnTokenClick !== false;
        if (autoPause && !this.adapter.isPlaybackPaused()) {
            this.adapter.pausePlayback();
            this.pausedByLearning = true;
        }

        const word = token.text.trim();
        const isMarked = this.userVocabWords.has(word.toLowerCase());

        this.popover.show({
            word,
            sourceLang: this.currentSourceLang,
            targetLang: this.currentTargetLang,
            tokenEl,
            container,
            isMarked,
            contextSentence: cueText,
            contextTranslation: translatedText,
            onToggleMark: () => {
                this.toggleUserMarkedWord(
                    word,
                    cueText,
                    translatedText,
                    tokenEl,
                );
            },
            onClose: () => {
                if (this.pausedByLearning) {
                    this.pausedByLearning = false;
                    this.adapter.resumePlayback();
                }
            },
        });

        // Check lookup cache
        const cacheKey = `${word}_${this.currentSourceLang}_${this.currentTargetLang}`;
        if (this.wordLookupCache.has(cacheKey)) {
            this.popover.updateDefinition(this.wordLookupCache.get(cacheKey)!);
            return;
        }

        // Fetch definition asynchronously
        this.messageService
            .lookupWordDefinition({
                word,
                contextSentence: cueText,
                contextTranslation: translatedText,
                sourceLang: this.currentSourceLang,
                targetLang: this.currentTargetLang,
            })
            .then((res) => {
                if (res && res.success && res.data) {
                    this.wordLookupCache.set(cacheKey, res.data);
                    this.popover.updateDefinition(res.data);
                }
            })
            .catch((err) => {
                this.logger.warn(
                    'Lookup',
                    'Failed lookup for word:',
                    word,
                    err,
                );
            });
    }

    /**
     * Handle user Right Click on a subtitle token:
     * Quick-marks or unmarks the word as a user vocabulary word.
     * Explicitly binds the context sentence as the example sentence.
     */
    handleTokenContextMenu(
        e: MouseEvent,
        token: SubtitleToken,
        cueText: string,
        translatedText: string | undefined,
        tokenEl: HTMLElement,
        container: HTMLElement,
    ): void {
        e.preventDefault();
        e.stopPropagation();

        if (!token.isWordLike || !token.text.trim()) return;

        const word = token.text.trim();
        this.toggleUserMarkedWord(
            word,
            cueText,
            translatedText,
            tokenEl,
            container,
        );
    }

    private async toggleUserMarkedWord(
        word: string,
        contextSentence: string,
        contextTranslation: string | undefined,
        tokenEl?: HTMLElement,
        container?: HTMLElement,
    ): Promise<void> {
        const movieId = this.currentMovieId || 'default';
        const normalized = word.toLowerCase();
        const isCurrentlyMarked = this.userVocabWords.has(normalized);

        if (isCurrentlyMarked) {
            // Remove word from user vocabulary
            this.userVocabWords.delete(normalized);
            if (tokenEl) {
                tokenEl.classList.remove('is-user-marked');
            }
            this.messageService.deleteUserVocabWord({ movieId, word });
            this.showToast(`🗑️ Removed "${word}" from vocabulary`, container);
        } else {
            // Add word to user vocabulary with context sentence as example!
            this.userVocabWords.add(normalized);
            if (tokenEl) {
                tokenEl.classList.add('is-user-marked');
            }

            const currentTimestamp =
                (await this.adapter?.getContentTime()) ??
                this.adapter?.getVideoElement()?.currentTime ??
                0;

            const wordItem: VocabWordItem = {
                word,
                pos: '',
                phonetic: '',
                meaning: '',
                sentence: contextSentence, // Contex sentence as example!
                sentenceTranslation: contextTranslation || '',
                timestamp: currentTimestamp,
                frequency: 1,
                source: 'user', // Explicitly user-marked!
                createdAt: Date.now(),
            };

            this.messageService.saveUserVocabWord({
                movieId,
                showTitle: this.currentShowTitle,
                wordItem,
            });

            this.showToast(`⭐ Saved "${word}" to vocabulary`, container);
        }
    }

    private showToast(message: string, container?: HTMLElement): void {
        const target = container || document.body;
        const toast = document.createElement('div');
        toast.className = 'ncw-learning-toast';
        toast.textContent = message;
        target.appendChild(toast);

        setTimeout(() => {
            if (toast.parentElement) {
                toast.parentElement.removeChild(toast);
            }
        }, 2200);
    }

    destroy(): void {
        this.popover.hide();
        this.learningCueCache.clear();
        this.wordLookupCache.clear();
        this.userVocabWords.clear();
    }
}
