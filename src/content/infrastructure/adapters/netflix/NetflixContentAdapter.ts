import {
    IStreamingAdapter,
    SubtitleCueData,
    VideoMetadata,
    IAdDetector,
    AdDetectorOptions,
} from '../../../domain/adapters/IStreamingAdapter';
import { SubtitleParser } from '../../../application/utils/parser';
import { NetflixSubtitleParser } from './NetflixSubtitleParser';
import { NetflixAdDetector } from './NetflixAdDetector';
import { STREAMING_PLATFORMS } from '@shared/domain/constants/StreamingPlatforms';
import { NCW_MESSAGE_TYPES } from '@shared/domain/constants/MessageTypes';
import { PlaybackDatasetHelper } from '@shared/domain/entities/PlaybackDatasetPayload';

export class NetflixContentAdapter implements IStreamingAdapter {
    readonly platformName = STREAMING_PLATFORMS.NETFLIX;
    private adDetector: NetflixAdDetector;
    private messageListeners: Array<(event: MessageEvent) => void> = [];
    private cachedMetadata?: VideoMetadata;

    constructor() {
        this.adDetector = new NetflixAdDetector();
    }

    createAdDetector(options?: AdDetectorOptions): IAdDetector {
        if (this.adDetector) {
            this.adDetector.stopMonitoring();
        }
        this.adDetector = new NetflixAdDetector(options);
        return this.adDetector;
    }

    matches(url: string): boolean {
        return /netflix\.com/i.test(url);
    }

    extractVideoId(url: string = window.location.href): string | null {
        const match = (url || '').match(/\/watch\/(\d+)/);
        if (match) return match[1];
        if (this.cachedMetadata?.videoId) return this.cachedMetadata.videoId;
        return null;
    }

    isPlaybackPage(url: string = window.location.href): boolean {
        return /\/watch\/(\d+)/.test(url) || Boolean(this.extractVideoId(url));
    }

    getVideoInfo(): VideoMetadata {
        const currentVideoId = this.extractVideoId() || '';
        if (this.cachedMetadata) {
            if (
                !currentVideoId ||
                (this.cachedMetadata.videoId &&
                    this.cachedMetadata.videoId !== currentVideoId)
            ) {
                this.cachedMetadata = undefined;
            } else {
                return this.cachedMetadata;
            }
        }
        const ds =
            typeof document !== 'undefined' && document.documentElement
                ? document.documentElement.dataset
                : undefined;
        if (currentVideoId && ds && (ds.ncwMainTitle || ds.ncwShowId)) {
            const mainTitle = ds.ncwMainTitle || '';
            const episodeTitle = ds.ncwEpisodeTitle || '';
            const fullTitle = episodeTitle
                ? mainTitle
                    ? `${mainTitle} - ${episodeTitle}`
                    : episodeTitle
                : mainTitle;
            return {
                mainTitle,
                episodeTitle,
                fullTitle,
                videoId: currentVideoId,
                showId: ds.ncwShowId,
                seasonId: ds.ncwSeasonId,
                showSummary: ds.ncwShowSummary,
                episodeSummary: ds.ncwEpisodeSummary,
            };
        }
        return {
            mainTitle: '',
            episodeTitle: '',
            fullTitle: '',
            videoId: currentVideoId,
        };
    }

    getVideoElement(): HTMLVideoElement | null {
        return document.querySelector('video');
    }

    getPlayerContainer(): HTMLElement | null {
        const candidate =
            (document.querySelector(
                '.watch-video--player-view',
            ) as HTMLElement | null) ||
            (document.querySelector(
                '[data-uia="watch-video"]',
            ) as HTMLElement | null) ||
            (document.querySelector('.NFPlayer') as HTMLElement | null) ||
            (document.querySelector('video')
                ?.parentElement as HTMLElement | null) ||
            null;

        if (candidate && candidate !== document.body) {
            return candidate;
        }
        return null;
    }

    async getContentTime(): Promise<number | null | undefined> {
        const currentVideoId = this.extractVideoId();

        // 1. Authoritative high-frequency dataset sync (Type 4)
        const payload = PlaybackDatasetHelper.read(currentVideoId);
        if (payload) {
            if (payload.isPaused) return payload.currentTime;
            const now = performance.now();
            const elapsed = Math.max(0, now - payload.syncAt);
            if (elapsed < 5000) {
                return payload.currentTime + (elapsed / 1000) * (payload.playbackRate || 1.0);
            }
            return payload.currentTime;
        }

        // 2. Legacy dataset fallback (for backwards compatibility during transition)
        if (document.documentElement && document.documentElement.dataset) {
            const atomicStr = document.documentElement.dataset.ncwSegmentAtomic;
            if (atomicStr) {
                const parts = atomicStr.split('|');
                if (parts.length >= 4) {
                    const baseTime = parseFloat(parts[0]);
                    const syncAt = parseFloat(parts[1]);
                    const isPaused = parts[2] === '1';
                    const rate = parseFloat(parts[3]) || 1.0;

                    if (!isNaN(baseTime) && baseTime >= 0) {
                        if (isPaused) return baseTime;
                        const now = performance.now();
                        const elapsed = Math.max(0, now - syncAt);
                        if (elapsed < 5000) {
                            return baseTime + (elapsed / 1000) * rate;
                        }
                        return baseTime;
                    }
                }
            }
        }

        // 3. Fallback to HTMLVideoElement currentTime
        const video = this.getVideoElement();
        if (video) {
            return video.currentTime || 0;
        }

        return undefined;
    }

    isAdActive(): boolean {
        return Boolean(this.adDetector.isAdPlaying);
    }

    pausePlayback(): void {
        const video = this.getVideoElement();
        if (video && !video.paused) {
            video.pause();
        }
    }

    resumePlayback(): void {
        const video = this.getVideoElement();
        if (video && video.paused) {
            video.play().catch(() => {});
        }
    }

    isPlaybackPaused(): boolean {
        const video = this.getVideoElement();
        return video ? video.paused : true;
    }

    onEpisodeChange(callback: (newEpisodeId: string) => void): () => void {
        const handler = (event: MessageEvent) => {
            if (event.source !== window || !event.data) return;
            if (
                event.data.type === NCW_MESSAGE_TYPES.EPISODE_CHANGED &&
                event.data.movieId
            ) {
                const newEpId = String(event.data.movieId);
                if (
                    this.cachedMetadata &&
                    this.cachedMetadata.videoId !== newEpId
                ) {
                    this.cachedMetadata = undefined;
                }
                callback(newEpId);
            }
        };
        window.addEventListener('message', handler);
        this.messageListeners.push(handler);
        return () => window.removeEventListener('message', handler);
    }

    onUrlChange(callback: (url: string) => void): () => void {
        const handler = (event: MessageEvent) => {
            if (event.source !== window || !event.data) return;
            if (
                event.data.type === NCW_MESSAGE_TYPES.URL_CHANGED &&
                event.data.url
            ) {
                callback(event.data.url);
            }
        };
        window.addEventListener('message', handler);
        this.messageListeners.push(handler);
        return () => window.removeEventListener('message', handler);
    }

    onTimeSync(
        callback: (offsets: {
            movieId: string;
            cadmiumOffset?: number;
            adOffset?: number;
        }) => void,
    ): () => void {
        const handler = (event: MessageEvent) => {
            if (event.source !== window || !event.data) return;
            if (event.data.type === NCW_MESSAGE_TYPES.TIME_SYNC) {
                const movieId = event.data.movieId
                    ? String(event.data.movieId)
                    : this.extractVideoId() || '';
                callback({
                    movieId,
                });
            }
        };
        window.addEventListener('message', handler);
        this.messageListeners.push(handler);
        return () => window.removeEventListener('message', handler);
    }

    onMetadataLoaded(callback: (metadata: VideoMetadata) => void): () => void {
        const handler = (event: MessageEvent) => {
            if (event.source !== window || !event.data) return;
            if (event.data.type === NCW_MESSAGE_TYPES.METADATA_LOADED) {
                const d = event.data;
                const meta: VideoMetadata = {
                    mainTitle: d.showTitle || '',
                    episodeTitle: d.currentEpisode?.episodeTitle || '',
                    fullTitle: d.currentEpisode?.episodeTitle
                        ? `${d.showTitle} - ${d.currentEpisode.episodeTitle}`
                        : d.showTitle || '',
                    videoId: d.currentEpisode?.episodeId || '',
                    showId: d.showId,
                    seasonId: d.seasonId,
                    showSummary: d.showSynopsis,
                    episodeSummary: d.currentEpisode?.episodeSynopsis,
                    seasonNum: d.seasonSeq,
                    episodeNum: d.currentEpisode?.episodeSeq,
                };
                this.cachedMetadata = meta;
                callback(meta);
            }
        };
        window.addEventListener('message', handler);
        this.messageListeners.push(handler);
        return () => window.removeEventListener('message', handler);
    }

    onSubtitlePreload(
        callback: (data: {
            movieId?: string;
            rawText: string;
            bcp47?: string | null;
            timestamp?: number;
        }) => void,
    ): () => void {
        const handler = (event: MessageEvent) => {
            if (event.source !== window || !event.data) return;
            if (event.data.type === NCW_MESSAGE_TYPES.SUBTITLE_PRELOAD_STAGED) {
                callback({
                    movieId: event.data.movieId
                        ? String(event.data.movieId)
                        : undefined,
                    rawText: event.data.rawText,
                    bcp47: event.data.bcp47 || null,
                    timestamp: event.data.timestamp,
                });
            }
        };
        window.addEventListener('message', handler);
        this.messageListeners.push(handler);
        return () => window.removeEventListener('message', handler);
    }

    parseSubtitle(rawText: string): SubtitleCueData[] {
        return NetflixSubtitleParser.parse(rawText);
    }

    onSubtitleData(
        callback: (data: {
            cues: SubtitleCueData[];
            language: string;
            movieId?: string;
            isAsr?: boolean;
        }) => void,
    ): () => void {
        const handler = (event: MessageEvent) => {
            if (event.source !== window || !event.data) return;
            if (
                event.data.type === NCW_MESSAGE_TYPES.SUBTITLE_RAW_DATA &&
                event.data.rawText
            ) {
                try {
                    const cues = this.parseSubtitle(event.data.rawText);
                    const lang =
                        event.data.bcp47 ||
                        SubtitleParser.detectLanguage(event.data.rawText, cues);
                    callback({
                        cues,
                        language: lang,
                        movieId: event.data.movieId,
                        isAsr: false,
                    });
                } catch (_err) {
                    // Ignore
                }
            }
        };
        window.addEventListener('message', handler);
        this.messageListeners.push(handler);
        return () => window.removeEventListener('message', handler);
    }

    onSubtitleOff(callback: (movieId: string) => void): () => void {
        const handler = (event: MessageEvent) => {
            if (event.source !== window || !event.data) return;
            if (event.data.type === NCW_MESSAGE_TYPES.SUBTITLE_OFF) {
                const movieId = event.data.movieId
                    ? String(event.data.movieId)
                    : this.extractVideoId() || '';
                callback(movieId);
            }
        };
        window.addEventListener('message', handler);
        this.messageListeners.push(handler);
        return () => window.removeEventListener('message', handler);
    }

    requestSubtitleRetry(): void {
        window.postMessage(
            { type: NCW_MESSAGE_TYPES.REQUEST_SUBTITLE_RETRY },
            '*',
        );
    }

    requestMetadata(movieId?: string): void {
        window.postMessage(
            {
                type: NCW_MESSAGE_TYPES.REQUEST_METADATA,
                movieId: movieId ? String(movieId) : undefined,
            },
            '*',
        );
    }

    async queryMetadata(
        movieId?: string,
    ): Promise<VideoMetadata | null | undefined> {
        const queryId = `qm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const effectiveMid = movieId ? String(movieId) : undefined;

        return new Promise<VideoMetadata | null | undefined>((resolve) => {
            let resolved = false;
            let timer: ReturnType<typeof setTimeout> | null = null;

            const handler = (event: MessageEvent) => {
                if (event.source !== window || !event.data) return;
                if (
                    event.data.type ===
                        NCW_MESSAGE_TYPES.QUERY_METADATA_RESULT &&
                    event.data.queryId === queryId
                ) {
                    resolved = true;
                    if (timer) clearTimeout(timer);
                    window.removeEventListener('message', handler);

                    const { status, metadata } = event.data;
                    if (status === 'resolved' && metadata) {
                        this.cachedMetadata = metadata;
                        resolve(metadata);
                    } else if (status === 'null') {
                        resolve(null);
                    } else {
                        resolve(undefined);
                    }
                }
            };

            window.addEventListener('message', handler);

            window.postMessage(
                {
                    type: NCW_MESSAGE_TYPES.QUERY_METADATA,
                    queryId,
                    movieId: effectiveMid,
                },
                '*',
            );

            timer = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    window.removeEventListener('message', handler);
                    resolve(undefined);
                }
            }, 1500);
        });
    }

    async fetchSubttile(
        movieId: string,
    ): Promise<{ rawText: string; bcp: string } | null | undefined> {
        const queryId = `qs_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        const effectiveMid = movieId ? String(movieId) : undefined;

        return new Promise<{ rawText: string; bcp: string } | null | undefined>(
            (resolve) => {
                let resolved = false;
                let timer: ReturnType<typeof setTimeout> | null = null;

                const handler = (event: MessageEvent) => {
                    if (event.source !== window || !event.data) return;
                    if (
                        event.data.type ===
                            NCW_MESSAGE_TYPES.QUERY_SUBTITLE_RESULT &&
                        event.data.queryId === queryId
                    ) {
                        resolved = true;
                        if (timer) clearTimeout(timer);
                        window.removeEventListener('message', handler);

                        const { status, rawText, bcp } = event.data;
                        if (status === 'resolved' && rawText && bcp) {
                            resolve({ rawText, bcp });
                        } else if (status === 'null') {
                            resolve(null);
                        } else {
                            resolve(undefined);
                        }
                    }
                };

                window.addEventListener('message', handler);
                this.messageListeners.push(handler);

                window.postMessage(
                    {
                        type: NCW_MESSAGE_TYPES.QUERY_SUBTITLE,
                        queryId,
                        movieId: effectiveMid,
                    },
                    '*',
                );

                timer = setTimeout(() => {
                    if (!resolved) {
                        resolved = true;
                        window.removeEventListener('message', handler);
                        resolve(undefined);
                    }
                }, 2000);
            },
        );
    }

    clearMetadata(): void {
        this.cachedMetadata = undefined;
        if (
            typeof document !== 'undefined' &&
            document.documentElement?.dataset
        ) {
            delete document.documentElement.dataset.ncwShowId;
            delete document.documentElement.dataset.ncwMainTitle;
            delete document.documentElement.dataset.ncwShowSummary;
            delete document.documentElement.dataset.ncwSeasonId;
            delete document.documentElement.dataset.ncwEpisodeTitle;
            delete document.documentElement.dataset.ncwEpisodeSummary;
        }
    }

    async fetchNativeTargetTrack(
        targetLang: import('@shared/domain/value-objects/Language').LanguageInfo,
        movieId?: string,
    ): Promise<SubtitleCueData[] | null | undefined> {
        const effectiveMid = movieId || this.extractVideoId() || '';
        const langCode = targetLang?.code || 'en';

        return new Promise<SubtitleCueData[] | null | undefined>((resolve) => {
            this.executeNativeTrackQuery(effectiveMid, langCode, resolve);
        });
    }

    private executeNativeTrackQuery(
        effectiveMid: string,
        langCode: string,
        resolve: (res: SubtitleCueData[] | null | undefined) => void,
    ): void {
        let resolved = false;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const cleanup = () => {
            if (resolved) return;
            resolved = true;
            if (timer) clearTimeout(timer);
            window.removeEventListener('message', handler);
        };

        const handler = (event: MessageEvent) => {
            if (event.source !== window || !event.data) return;
            if (
                this.isMatchingNativeTrackMessage(
                    event.data,
                    effectiveMid,
                    langCode,
                )
            ) {
                cleanup();
                resolve(this.parseNativeTrackResponse(event.data));
            }
        };

        window.addEventListener('message', handler);
        this.messageListeners.push(handler);
        timer = setTimeout(() => {
            cleanup();
            resolve(undefined);
        }, 3500);

        window.postMessage(
            {
                type: NCW_MESSAGE_TYPES.QUERY_NATIVE_TRACK,
                movieId: effectiveMid,
                targetLangCode: langCode,
            },
            '*',
        );
    }

    private isMatchingNativeTrackMessage(
        data: { type?: string; movieId?: string; targetLangCode?: string },
        effectiveMid: string,
        langCode: string,
    ): boolean {
        return (
            data.type === NCW_MESSAGE_TYPES.NATIVE_TRACK_DATA &&
            data.movieId === effectiveMid &&
            (data.targetLangCode === langCode || !data.targetLangCode)
        );
    }

    private parseNativeTrackResponse(data: {
        status?: string;
        found?: boolean;
        rawText?: string;
    }): SubtitleCueData[] | null | undefined {
        if (data.status === 'not_ready') return undefined;
        if (data.status === 'not_found' || !data.found) return null;
        if (data.rawText) {
            try {
                return this.parseSubtitle(data.rawText);
            } catch {
                return null;
            }
        }
        return null;
    }

    dispose(): void {
        this.adDetector.stopMonitoring();
        this.messageListeners.forEach((fn) =>
            window.removeEventListener('message', fn),
        );
        this.messageListeners = [];
    }
}
