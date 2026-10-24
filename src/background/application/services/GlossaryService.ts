import {
    Context,
    ContextDTO,
    EpisodeContext,
} from '@shared/domain/entities/Context';
import {
    CharacterGlossaryMap,
    TermGlossaryMap,
} from '@shared/domain/entities/Glossary';
import { ContentBackgroundBus } from '@shared/infrastructure/bus/ContentBackgroundBus';
import { IBrowserStorage } from '@shared/infrastructure/storage/IBrowserStorage';
import { BrowserStorageFactory } from '@shared/infrastructure/storage/BrowserStorageFactory';
import { LanguageInfo } from '@shared/domain/value-objects/Language';
import NCW_CONSTANTS from '@shared/utils/constants';
import { Logger } from '@shared/utils/logger';

export class GlossaryService {
    private static instance: GlossaryService | null = null;
    private showContextMap: Map<string, Context> = new Map(); // string means cache key, see getCacheKey
    private tabContextMap: Map<number, string> = new Map(); // number means tab id, string means showContextMap id.
    private storage: IBrowserStorage;

    private logger: Logger = new Logger('GlossaryService');

    private constructor(
        storage: IBrowserStorage = BrowserStorageFactory.getStorage(),
    ) {
        this.storage = storage;
    }

    static getInstance(storage?: IBrowserStorage): GlossaryService {
        if (!GlossaryService.instance) {
            GlossaryService.instance = new GlossaryService(storage);
        }
        return GlossaryService.instance;
    }

    bindTabContext(tabId?: number, context?: Context): void {
        this.logger.info(
            'Glossary',
            `Bind tab to context: tab ${tabId} - context ${context?.showId} - ${context?.targetLanguage.code}`,
        );
        if (
            tabId === undefined ||
            context === undefined ||
            context.showId === undefined ||
            !context.showId ||
            context.targetLanguage === undefined
        )
            return;
        const showKey = this.getCacheKey(
            context.targetLanguage,
            context.showId,
        );
        this.tabContextMap.set(tabId, showKey);
    }

    getContextForTab(tabId?: number): Context | null {
        this.logger.info('Glossary', `Get context for tab ${tabId}`);
        if (tabId === undefined) return null;
        this.logger.info(
            'Glossary',
            `Get context for tab and the tab context map is ${JSON.stringify(this.tabContextMap, null, 2)}, and the show context map is ${JSON.stringify(this.showContextMap)}`,
        );
        if (this.tabContextMap.has(tabId)) {
            const showContextId = this.tabContextMap.get(tabId);
            if (showContextId === undefined) return null;
            if (this.showContextMap.has(showContextId)) {
                return this.showContextMap.get(showContextId) ?? null;
            }
        }
        return null;
    }

    unbindTabContext(tabId?: number): void {
        this.logger.info('Glossary', `Unbind tab context for ${tabId}`);
        if (tabId === undefined) return;
        this.tabContextMap.delete(tabId);
    }

    private getCacheKey(lang: LanguageInfo | null, showId: string): string {
        if (lang === undefined || !lang)
            this.logger.error(
                'Glossary',
                `ShowId: ${showId} wants to use a undefined/null language to generate a cache key! Someone must make some mistakes!`,
            );
        const showIdStr = showId;
        const langStr = lang ? lang.code : 'unknown';

        return `ncw_show_${showIdStr}_${langStr}`;
    }

    async initialize(): Promise<void> {
        // try {
        //   const all = await this.storage.get<Record<string, unknown>>(null);
        //   if (all && typeof all === 'object') {
        //     for (const [key, val] of Object.entries(all)) {
        //       if (key.startsWith('ctx_') && val && typeof val === 'object') {
        //         this.showContextMap.set(key, Context.fromDTO(val));
        //       }
        //     }
        //   }
        // } catch (err) {
        //   this.logger.error('Failed to initialize context map from storage', err);
        // }
    }

    async getContextForShow(
        showId: string,
        targetLanguage: LanguageInfo,
    ): Promise<Context | null> {
        const key = this.getCacheKey(targetLanguage, showId);
        let ctx = this.showContextMap.get(key);
        if (!ctx) {
            const res = await this.storage.get<ContextDTO>([key]);
            if (res[key]) {
                ctx = Context.fromDTO(res[key]);
                this.showContextMap.set(key, ctx);
            }
        }
        return ctx || null;
    }

    async getOrCreateContext(params: {
        showId: string;
        targetLanguage: LanguageInfo;
        title?: string;
        mainTitle?: string;
        showSynopsis?: string;
        episodeSynopsis?: string;
        episodeId?: string;
        episodeNumber?: string;
        seasonId?: string;
    }): Promise<Context> {
        const {
            showId,
            targetLanguage,
            title,
            mainTitle,
            showSynopsis,
            episodeSynopsis,
            episodeId,
            episodeNumber,
            seasonId,
        } = params;
        const existing = await this.getContextForShow(showId, targetLanguage);
        if (existing) {
            return existing;
        }

        const newContext = new Context({
            showId,
            title: title || '',
            mainTitle: mainTitle || '',
            targetLanguage,
            showSynopsis,
            episodes: [],
            characters: {},
            manualSetupCharacters: {},
            terms: {},
            manualSetupTerms: {},
            termVersions: {},
            isWarmedUp: false,
            updatedAt: Date.now(),
        });

        if (episodeId !== undefined) {
            const newEpisodeContext: EpisodeContext = {
                seasonId: seasonId || 'unknown',
                videoId: episodeId,
                episodeNumber: episodeNumber,
                title: title,
                synopsis: episodeSynopsis || 'unknown',
            };
            newContext.episodes.push(newEpisodeContext);
        }

        const key = this.getCacheKey(targetLanguage, showId);

        this.showContextMap.set(key, newContext);
        await this.storage.set({ [key]: newContext.toDTO() });
        return newContext;
    }

    async updateWarmupContext(params: {
        showId: string;
        targetLanguage: LanguageInfo;
        title?: string;
        mainTitle?: string;
        showSynopsis?: string;
        episode?: {
            seasonId: string;
            videoId: string;
            episodeNumber?: string;
            title?: string;
            synopsis: string;
        };
        known?: boolean;
        characters?: CharacterGlossaryMap;
        terms?: TermGlossaryMap;
    }): Promise<Context> {
        const {
            showId,
            targetLanguage,
            title,
            mainTitle,
            showSynopsis,
            episode,
            known,
            characters,
            terms,
        } = params;
        this.logger.info(
            'Glossary',
            `Update warm up context for show ${showId} targetLanguage ${targetLanguage.code}`,
        );
        const key = this.getCacheKey(targetLanguage, showId);
        const base = await this.getOrCreateContext({
            showId,
            targetLanguage,
            title,
            mainTitle,
            showSynopsis,
        });

        const merged = base.mergeDiscoveredGlossary(
            characters || {},
            terms || {},
        );

        const episodes = [...merged.episodes];
        if (episode && episode.videoId) {
            const idx = episodes.findIndex(
                (e) => e.videoId === episode.videoId,
            );
            if (idx >= 0) {
                episodes[idx] = { ...episodes[idx], ...episode };
            } else {
                episodes.push(episode);
            }
        }

        const updatedContext = new Context({
            ...merged.toDTO(),
            showId,
            title: title || merged.title,
            mainTitle: mainTitle || merged.mainTitle,
            targetLanguage,
            showSynopsis:
                showSynopsis !== undefined && showSynopsis !== ''
                    ? showSynopsis
                    : merged.showSynopsis,
            episodes,
            known: known ?? merged.known,
            isWarmedUp: true,
            updatedAt: Date.now(),
        });

        this.showContextMap.set(key, updatedContext);
        await this.persistAndBroadcast(updatedContext);
        return updatedContext;
    }

    async updateManualTerm(
        showId: string,
        targetLanguage: LanguageInfo,
        key: string,
        value: string,
    ): Promise<Context | null> {
        const cacheKey = this.getCacheKey(targetLanguage, showId);
        let current = this.showContextMap.get(cacheKey);
        if (!current) {
            current =
                (await this.getContextForShow(showId, targetLanguage)) ??
                undefined;
        }
        if (!current) {
            this.logger.error(
                'Glossary',
                'we cannot update manual term without context found!, showId: ',
                showId,
                ', targetLanguage: ',
                targetLanguage,
                ', key: ',
                key,
                ', value: ',
                value,
            );
            throw Error(
                `we cannot update manual term without context found for showId: ${showId}`,
            );
        }

        const updated = current.updateTerm(key, value);
        this.showContextMap.set(cacheKey, updated);
        await this.persistAndBroadcast(updated);
        return updated;
    }

    async deleteTerm(
        showId: string,
        targetLanguage: LanguageInfo,
        key: string,
    ): Promise<Context> {
        const cacheKey = this.getCacheKey(targetLanguage, showId);
        let current = this.showContextMap.get(cacheKey);
        if (!current) {
            current =
                (await this.getContextForShow(showId, targetLanguage)) ??
                undefined;
        }
        if (!current) {
            this.logger.error(
                'Glossary',
                'we cannot delete manual term without context found!, showId: ',
                showId,
                ', targetLanguage: ',
                targetLanguage,
                ', key: ',
                key,
            );
            throw new Error(`Context not found for showId: ${showId}`);
        }

        const updated = current.deleteTerm(key);
        this.showContextMap.set(cacheKey, updated);
        await this.persistAndBroadcast(updated);
        return updated;
    }

    async updateCharacter(
        showId: string,
        targetLanguage: LanguageInfo,
        name: string,
        canonical: string,
        aliases: string[] = [],
    ): Promise<Context> {
        const cacheKey = this.getCacheKey(targetLanguage, showId);
        let current = this.showContextMap.get(cacheKey);
        if (!current) {
            current =
                (await this.getContextForShow(showId, targetLanguage)) ??
                undefined;
        }
        if (!current) {
            this.logger.error(
                'Glossary',
                'we cannot update character without context found!, showId: ',
                showId,
                ', targetLanguage: ',
                targetLanguage,
                ', name: ',
                name,
                ', canonical: ',
                canonical,
                ', aliases: ',
                aliases,
            );
            throw new Error(`Context not found for showId: ${showId}`);
        }

        const updated = current.updateCharacter(name, canonical, aliases);
        this.showContextMap.set(cacheKey, updated);
        await this.persistAndBroadcast(updated);
        return updated;
    }

    async deleteCharacter(
        showId: string,
        targetLanguage: LanguageInfo,
        name: string,
    ): Promise<Context> {
        const cacheKey = this.getCacheKey(targetLanguage, showId);
        let current = this.showContextMap.get(cacheKey);
        if (!current) {
            current =
                (await this.getContextForShow(showId, targetLanguage)) ??
                undefined;
        }
        if (!current) {
            this.logger.error(
                'Glossary',
                'we cannot delete character without context found!, showId: ',
                showId,
                ', targetLanguage: ',
                targetLanguage,
                ', name: ',
                name,
            );
            throw new Error(`Context not found for showId: ${showId}`);
        }

        const updated = current.deleteCharacter(name);
        this.showContextMap.set(cacheKey, updated);
        await this.persistAndBroadcast(updated);
        return updated;
    }

    async bulkUpdateGlossary(params: {
        showId: string;
        targetLanguage: LanguageInfo;
        characters?: CharacterGlossaryMap;
        terms?: TermGlossaryMap;
    }): Promise<Context> {
        const { showId, targetLanguage, characters, terms } = params;
        const cacheKey = this.getCacheKey(targetLanguage, showId);
        let current = this.showContextMap.get(cacheKey);
        if (!current) {
            current =
                (await this.getContextForShow(showId, targetLanguage)) ??
                undefined;
        }
        if (!current) {
            this.logger.error(
                'Glossary',
                'we cannot bulk update glossary without context found!, showId: ',
                showId,
                ', targetLanguage: ',
                targetLanguage,
            );
            throw new Error(`Context not found for showId: ${showId}`);
        }

        let updated = current;
        if (characters && typeof characters === 'object') {
            for (const [name, char] of Object.entries(characters)) {
                if (!name.trim()) continue;
                const canonical = char.canonical || name;
                const aliases = Array.isArray(char.aliases) ? char.aliases : [];
                updated = updated.updateCharacter(
                    name.trim(),
                    canonical.trim(),
                    aliases,
                );
            }
        }

        if (terms && typeof terms === 'object') {
            for (const [k, v] of Object.entries(terms)) {
                if (k.trim() && v && typeof v === 'string') {
                    updated = updated.updateTerm(k.trim(), v.trim());
                }
            }
        }

        this.showContextMap.set(cacheKey, updated);
        await this.persistAndBroadcast(updated);
        return updated;
    }

    async resetContext(
        showId: string,
        targetLanguage: LanguageInfo,
    ): Promise<Context> {
        const cacheKey = this.getCacheKey(targetLanguage, showId);
        this.showContextMap.delete(cacheKey);
        await this.storage.remove([cacheKey]);

        // Clean up any tab references pointing to this show
        for (const [tabId, showContextId] of this.tabContextMap.entries()) {
            if (showContextId === cacheKey) {
                this.tabContextMap.delete(tabId);
            }
        }

        const empty = Context.createEmpty(targetLanguage);
        ContentBackgroundBus.broadcastToTabs(
            NCW_CONSTANTS.MESSAGE_TYPES.PUSH_GLOSSARY_CHANGED,
            {
                context: empty.toDTO(),
            },
        ).catch(() => {});

        return empty;
    }

    async unloadContext(
        showId: string,
        targetLanguage: LanguageInfo,
    ): Promise<void> {
        if (!showId) return;
        const cacheKey = this.getCacheKey(targetLanguage, showId);
        this.showContextMap.delete(cacheKey);

        for (const [tabId, showContextId] of this.tabContextMap.entries()) {
            if (showContextId === cacheKey) {
                this.tabContextMap.delete(tabId);
            }
        }
    }

    private async persistAndBroadcast(context: Context): Promise<void> {
        if (!context.showId) {
            this.logger.error(
                'Glossary',
                'We cannot persist context without showid! cts: ',
                context,
            );
            return;
        }
        const key = this.getCacheKey(context.targetLanguage, context.showId);
        await this.storage.set({ [key]: context.toDTO() });
        ContentBackgroundBus.broadcastToTabs(
            NCW_CONSTANTS.MESSAGE_TYPES.PUSH_GLOSSARY_CHANGED,
            {
                context: context.toDTO(),
            },
        ).catch(() => {});
    }
}
