import {
    IInjectedAdapter,
    InjectedIncomingEvent,
    InjectedSubtitleRawDataPayload,
    InjectedMetadataLoadedPayload,
    InjectedSubtitleOffPayload,
    InjectedAdStateChangedPayload,
    InjectedEpisodeChangedPayload,
    InjectedUrlChangedPayload,
    InjectedNativeTrackDataPayload,
} from '../../../domain/IInjectedAdapter';
import { VideoMetadata } from '../../../../content/domain/adapters/IStreamingAdapter';
import {
    STREAMING_PLATFORMS,
    StreamingPlatformId,
} from '@shared/domain/constants/StreamingPlatforms';
import { NCW_MESSAGE_TYPES } from '@shared/domain/constants/MessageTypes';
import { PlaybackDatasetHelper } from '@shared/domain/entities/PlaybackDatasetPayload';
import { NetworkHook } from '../../network/NetworkHook';
import { Logger } from '@shared/utils/logger';
import { YouTubeTrackRegistry } from './YouTubeTrackRegistry';
import {
    YouTubePlayerElement,
    YouTubeCachedSubtitle,
} from './YouTubeTypes';

export class YouTubeInjectedAdapter implements IInjectedAdapter {
    readonly platformId: StreamingPlatformId = STREAMING_PLATFORMS.YOUTUBE;
    private readonly logger: Logger = new Logger('YouTubeInjectedAdapter');

    private readonly trackRegistry: YouTubeTrackRegistry;

    private lastReportedUrl = '';
    private lastObservedVideoId: string | null = null;
    private lastAdState = false;
    private lastReportedTime: number | null = null;
    private lastTimeUpdateSync = 0;

    private pollIntervalId: ReturnType<typeof setInterval> | null = null;
    private playerBridgeAttached = false;
    private playerAdListener?: (...args: unknown[]) => void;
    private playerOptionListener?: (...args: unknown[]) => void;

    // Lifecycle cleanups
    private unhookNetwork?: () => void;
    private unhookNavigation?: () => void;
    private cleanupMessageListener?: () => void;
    private unhookPlayerEvents?: () => void;

    constructor() {
        this.trackRegistry = new YouTubeTrackRegistry();
    }

    matches(url: string): boolean {
        return /youtube\.com/i.test(url);
    }

    initialize(): void {
        if (window.__NCW_YOUTUBE_INTERCEPTOR_INITIALIZED__) return;
        window.__NCW_YOUTUBE_INTERCEPTOR_INITIALIZED__ = true;

        this.lastReportedUrl = window.location.href;
        this.lastObservedVideoId = this.extractVideoId(window.location.href);

        this.logger.info(
            'YouTube-AI-Sub',
            'Initializing YouTube Injected Adapter in MAIN world.',
        );

        this.setupNetworkInterceptor();
        this.setupNavigationMonitoring();
        this.setupPlayerBridge();
        this.setupPlayerEventHooks();
        this.setupMessageListener();

        // Background polling for route, ad, and captions state
        this.pollIntervalId = setInterval(() => {
            this.checkUrlAndVideoChange();
            this.checkPlayerAdState();
            this.checkPlayerCaptionsState();
            this.syncPlaybackState();
        }, 500);

        // Initial warmup
        setTimeout(() => {
            this.emitMetadataForCurrentVideo();
            this.checkPlayerCaptionsState();
            this.syncPlaybackState();
        }, 600);
    }

    destroy(): void {
        if (this.pollIntervalId) {
            clearInterval(this.pollIntervalId);
            this.pollIntervalId = null;
        }

        this.cleanupMessageListener?.();
        this.unhookNavigation?.();
        this.unhookPlayerEvents?.();
        this.teardownPlayerBridge();
        this.unhookNetwork?.();

        this.trackRegistry.clear();
        PlaybackDatasetHelper.clear();

        window.__NCW_YOUTUBE_INTERCEPTOR_INITIALIZED__ = false;
        this.logger.info('YouTube-AI-Sub', 'YouTubeInjectedAdapter destroyed and cleaned up.');
    }

    // --------------------------------------------------------------------------
    // 1. Helpers & Extraction
    // --------------------------------------------------------------------------

    private extractVideoId(url: string = window.location.href): string | null {
        if (!url) return null;
        try {
            const urlObj = new URL(url, window.location.origin);
            const v = urlObj.searchParams.get('v');
            if (v) return v;

            const pathname = urlObj.pathname;
            const shortsMatch = pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
            if (shortsMatch) return shortsMatch[1];

            const embedMatch = pathname.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
            if (embedMatch) return embedMatch[1];

            const liveMatch = pathname.match(/\/live\/([a-zA-Z0-9_-]{11})/);
            if (liveMatch) return liveMatch[1];
        } catch {
            const match = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
            if (match) return match[1];
        }
        return null;
    }

    private getCurrentVideoId(): string | null {
        return (
            this.lastObservedVideoId ||
            this.extractVideoId(window.location.href)
        );
    }

    private getPlayerElement(): YouTubePlayerElement | null {
        return (
            (document.getElementById('movie_player') as YouTubePlayerElement | null) ||
            window.ytplayer ||
            null
        );
    }

    private getVideoElement(): HTMLVideoElement | null {
        return (
            (document.querySelector('#movie_player video') as HTMLVideoElement | null) ||
            (document.querySelector('video.html5-main-video') as HTMLVideoElement | null) ||
            document.querySelector('video')
        );
    }

    // --------------------------------------------------------------------------
    // 2. Network Interceptor (Fetch timedtext)
    // --------------------------------------------------------------------------

    private setupNetworkInterceptor(): void {
        this.unhookNetwork = NetworkHook.onSubtitlePayload((url, text) => {
            if (!url.toLowerCase().includes('timedtext')) return;
            this.handleInterceptedSubtitle(url, text);
        });
    }

    private handleInterceptedSubtitle(url: string, text: string): void {
        const currentVideoId = this.getCurrentVideoId();
        const cached = this.trackRegistry.handleInterceptedSubtitle(url, text, currentVideoId);
        if (!cached) return;

        // If intercepted subtitle is for current playing video, emit to Content
        if (cached.videoId === currentVideoId) {
            const record = this.trackRegistry.getVideoRecord(cached.videoId);
            const signature = `${cached.videoId}_${cached.trackKey}_${text.length}`;
            if (signature !== record.lastEmittedSignature) {
                record.lastEmittedSignature = signature;
                record.activeTrackKey = cached.trackKey;
                record.userExplicitlyDisabledCaptions = false;

                const payload: InjectedSubtitleRawDataPayload = {
                    type: NCW_MESSAGE_TYPES.SUBTITLE_RAW_DATA,
                    movieId: cached.videoId,
                    url,
                    pageUrl: window.location.href,
                    rawText: text,
                    bcp47: cached.languageCode,
                    timestamp: Date.now(),
                    isAsr: cached.isAsr,
                };
                window.postMessage(payload, '*');
            }
        }
    }

    // --------------------------------------------------------------------------
    // 3. Navigation & Route Monitoring
    // --------------------------------------------------------------------------

    private setupNavigationMonitoring(): void {
        const onNavigate = () => {
            this.checkUrlAndVideoChange();
            setTimeout(() => {
                this.emitMetadataForCurrentVideo();
                this.checkPlayerCaptionsState();
                this.syncPlaybackState();
            }, 500);
        };

        document.addEventListener('yt-navigate-finish', onNavigate);
        window.addEventListener('popstate', onNavigate);

        this.unhookNavigation = () => {
            document.removeEventListener('yt-navigate-finish', onNavigate);
            window.removeEventListener('popstate', onNavigate);
        };
    }

    private checkUrlAndVideoChange(): void {
        const currentUrl = window.location.href;
        if (currentUrl !== this.lastReportedUrl) {
            this.lastReportedUrl = currentUrl;
            const urlPayload: InjectedUrlChangedPayload = {
                type: NCW_MESSAGE_TYPES.URL_CHANGED,
                url: currentUrl,
            };
            window.postMessage(urlPayload, '*');
        }

        const currentVideoId = this.extractVideoId(currentUrl);
        if (currentVideoId && currentVideoId !== this.lastObservedVideoId) {
            this.lastObservedVideoId = currentVideoId;

            const epPayload: InjectedEpisodeChangedPayload = {
                type: NCW_MESSAGE_TYPES.EPISODE_CHANGED,
                movieId: currentVideoId,
                url: currentUrl,
            };
            window.postMessage(epPayload, '*');
            this.emitMetadataForCurrentVideo();

            // Replay cached subtitle if previously viewed in SPA session
            const record = this.trackRegistry.getVideoRecord(currentVideoId);
            if (record.cachedSubtitles.size > 0 && record.activeTrackKey) {
                const cached =
                    record.cachedSubtitles.get(record.activeTrackKey) ||
                    record.cachedSubtitles.values().next().value;
                if (cached) {
                    this.logger.info(
                        'YouTube-AI-Sub',
                        `Replaying cached subtitle for returning video ${currentVideoId}`,
                    );
                    this.emitCachedSubtitle(cached, true);
                }
            }
        }
    }

    // --------------------------------------------------------------------------
    // 4. Metadata Extraction with Strong Consistency (video_id check)
    // --------------------------------------------------------------------------

    private emitMetadataForCurrentVideo(): void {
        const videoId = this.getCurrentVideoId();
        if (!videoId) return;

        let title = '';
        let description = '';

        const player = this.getPlayerElement();
        if (player && typeof player.getVideoData === 'function') {
            try {
                const data = player.getVideoData();
                // Strictly guarantee title matches the target videoId
                if (data && data.video_id === videoId && data.title) {
                    title = data.title;
                }
            } catch {}
        }

        if (!title && window.ytInitialPlayerResponse?.videoDetails) {
            const details = window.ytInitialPlayerResponse.videoDetails;
            if (details.videoId === videoId) {
                if (details.title) title = details.title;
                if (details.shortDescription) description = details.shortDescription;
            }
        }

        if (!title) {
            title = document.title
                ? document.title.replace(/\s*-\s*YouTube$/i, '').trim()
                : '';
        }

        if (title) {
            const metaPayload: InjectedMetadataLoadedPayload = {
                type: NCW_MESSAGE_TYPES.METADATA_LOADED,
                movieId: videoId,
                showId: videoId,
                showTitle: title,
                showSynopsis: description || undefined,
            };
            window.postMessage(metaPayload, '*');
        }
    }

    // --------------------------------------------------------------------------
    // 5. Player Bridge & Event Hooks
    // --------------------------------------------------------------------------

    private setupPlayerBridge(): void {
        if (this.playerBridgeAttached) return;
        const player = this.getPlayerElement();
        if (!player || typeof player.addEventListener !== 'function') return;

        try {
            this.playerAdListener = (state: unknown) => {
                const isAd = Boolean(state === 1 || state === true);
                this.reportAdState(isAd);
            };
            this.playerOptionListener = (option: unknown, value: unknown) => {
                if (option === 'captions') {
                    this.handleCaptionsOptionChange(value as { languageCode?: string; kind?: string; vssId?: string } | null);
                }
            };

            player.addEventListener('onAdStateChange', this.playerAdListener);
            player.addEventListener('onOptionChange', this.playerOptionListener);
            this.playerBridgeAttached = true;
        } catch {}
    }

    private teardownPlayerBridge(): void {
        const player = this.getPlayerElement();
        if (player && typeof player.removeEventListener === 'function') {
            if (this.playerAdListener) {
                player.removeEventListener('onAdStateChange', this.playerAdListener);
            }
            if (this.playerOptionListener) {
                player.removeEventListener('onOptionChange', this.playerOptionListener);
            }
        }
        this.playerBridgeAttached = false;
        this.playerAdListener = undefined;
        this.playerOptionListener = undefined;
    }

    private setupPlayerEventHooks(): void {
        const onTimeUpdate = () => {
            const now = performance.now();
            if (now - this.lastTimeUpdateSync > 250) {
                this.lastTimeUpdateSync = now;
                this.syncPlaybackState();
            }
        };

        const onStateChange = () => setTimeout(() => this.syncPlaybackState(), 50);
        const playerEvents = ['seeked', 'playing', 'pause', 'ratechange'] as const;

        window.addEventListener('timeupdate', onTimeUpdate, { capture: true, passive: true });
        playerEvents.forEach((evt) => {
            window.addEventListener(evt, onStateChange, { capture: true, passive: true });
        });

        this.unhookPlayerEvents = () => {
            window.removeEventListener('timeupdate', onTimeUpdate, { capture: true });
            playerEvents.forEach((evt) => {
                window.removeEventListener(evt, onStateChange, { capture: true });
            });
        };
    }

    // --------------------------------------------------------------------------
    // 6. Playback State Synchronization (Type 4 Dataset + TimeSync Events)
    // --------------------------------------------------------------------------

    private syncPlaybackState(): void {
        const videoId = this.getCurrentVideoId();
        if (!videoId) return;

        // Lazy attach player bridge if not yet bound
        if (!this.playerBridgeAttached) {
            this.setupPlayerBridge();
        }

        const video = this.getVideoElement();
        const player = this.getPlayerElement();
        if (!video && !player) return;

        let currentTime = 0;
        if (player && typeof player.getCurrentTime === 'function') {
            try {
                const t = player.getCurrentTime();
                if (typeof t === 'number' && !isNaN(t) && t >= 0) currentTime = t;
            } catch {}
        }
        if (!currentTime && video && typeof video.currentTime === 'number') {
            currentTime = video.currentTime;
        }

        const isPaused = video ? video.paused : (player?.getPlayerState?.() === 2);
        const playbackRate = player?.getPlaybackRate?.() || video?.playbackRate || 1.0;
        const nowPerf = performance.now();

        // 1. Authoritative Type 4 High-Frequency Dataset Sync
        PlaybackDatasetHelper.write({
            movieId: videoId,
            currentTime,
            syncAt: nowPerf,
            isPaused,
            playbackRate,
        });

        // 2. Low-frequency TIME_SYNC Event
        if (
            this.lastReportedTime === null ||
            Math.abs(currentTime - this.lastReportedTime) > 0.5
        ) {
            this.lastReportedTime = currentTime;
            window.postMessage(
                {
                    type: NCW_MESSAGE_TYPES.TIME_SYNC,
                    movieId: videoId,
                    segmentTime: currentTime,
                    syncAt: nowPerf,
                    isPaused,
                    playbackRate,
                    cadmiumOffset: 0,
                    adOffset: 0,
                },
                '*',
            );
        }
    }

    private checkPlayerAdState(): void {
        const player = this.getPlayerElement();
        let isAd = false;

        if (player) {
            if (typeof player.getAdState === 'function') {
                try {
                    isAd = player.getAdState() === 1;
                } catch {}
            }
            if (!isAd && player.classList) {
                isAd =
                    player.classList.contains('ad-showing') ||
                    player.classList.contains('ad-interrupting');
            }
        }

        if (isAd !== this.lastAdState) {
            this.reportAdState(isAd);
        }
    }

    private reportAdState(isAd: boolean): void {
        if (isAd === this.lastAdState) return;
        this.lastAdState = isAd;

        const videoId = this.getCurrentVideoId();
        const payload: InjectedAdStateChangedPayload = {
            type: NCW_MESSAGE_TYPES.AD_STATE_CHANGED,
            isAd,
            movieId: videoId || undefined,
        };
        window.postMessage(payload, '*');
    }

    // --------------------------------------------------------------------------
    // 7. Caption Track Selection & State Observers
    // --------------------------------------------------------------------------

    private checkPlayerCaptionsState(): void {
        const player = this.getPlayerElement();
        const currentVideoId = this.getCurrentVideoId();
        if (!player || !currentVideoId) return;

        try {
            // Guard against video desynchronization during route transitions
            if (typeof player.getVideoData === 'function') {
                const playerVideoId = player.getVideoData()?.video_id;
                if (playerVideoId && playerVideoId !== currentVideoId) {
                    return;
                }
            }

            const record = this.trackRegistry.getVideoRecord(currentVideoId);
            this.trackRegistry.refreshVideoTracks(currentVideoId, player);

            if (typeof player.getOption !== 'function') return;
            const track = player.getOption('captions', 'track') as {
                languageCode?: string;
                kind?: string;
                vssId?: string;
            } | null;
            const hasActiveTrack = Boolean(track && track.languageCode);

            if (hasActiveTrack && track && track.languageCode) {
                const lang = track.languageCode;
                const isAsr =
                    track.kind === 'asr' ||
                    (track.vssId ? track.vssId.startsWith('a.') : false);
                const trackKey = `${lang}_${isAsr ? 'asr' : 'normal'}`;

                record.activeTrackKey = trackKey;
                record.userExplicitlyDisabledCaptions = false;

                const cached =
                    record.cachedSubtitles.get(trackKey) ||
                    record.cachedSubtitles.get(lang);

                if (cached) {
                    const sig = `${currentVideoId}_${trackKey}_${cached.rawText.length}`;
                    if (sig !== record.lastEmittedSignature) {
                        record.lastEmittedSignature = sig;
                        this.logger.info(
                            'YouTube-AI-Sub',
                            `Instant cache hit for active track [${trackKey}], emitting to content script.`,
                        );
                        this.emitCachedSubtitle(cached, false);
                    }
                } else if (!record.isFetchingActiveTrack) {
                    this.trackRegistry.fetchAndCacheTrack(currentVideoId, track);
                }
            } else {
                const playerState =
                    typeof player.getPlayerState === 'function'
                        ? player.getPlayerState()
                        : -1;
                const isPlayingOrPaused =
                    playerState === 1 || playerState === 2;

                if (
                    isPlayingOrPaused &&
                    record.activeTrackKey !== null &&
                    !record.userExplicitlyDisabledCaptions
                ) {
                    record.userExplicitlyDisabledCaptions = true;
                    record.activeTrackKey = null;
                    record.lastEmittedSignature = undefined;

                    this.logger.info(
                        'YouTube-AI-Sub',
                        `Captions explicitly disabled by user for ${currentVideoId}`,
                    );
                    const offPayload: InjectedSubtitleOffPayload = {
                        type: NCW_MESSAGE_TYPES.SUBTITLE_OFF,
                        movieId: currentVideoId,
                        timestamp: Date.now(),
                    };
                    window.postMessage(offPayload, '*');
                }
            }
        } catch (err) {
            this.logger.debug('YouTube-AI-Sub', 'Error in checkPlayerCaptionsState:', err);
        }
    }

    private handleCaptionsOptionChange(
        value: { languageCode?: string; kind?: string; vssId?: string } | null,
    ): void {
        const currentVideoId = this.getCurrentVideoId();
        if (!currentVideoId) return;

        const record = this.trackRegistry.getVideoRecord(currentVideoId);

        if (!value || !value.languageCode) {
            if (
                record.activeTrackKey !== null &&
                !record.userExplicitlyDisabledCaptions
            ) {
                record.userExplicitlyDisabledCaptions = true;
                record.activeTrackKey = null;
                record.lastEmittedSignature = undefined;

                const offPayload: InjectedSubtitleOffPayload = {
                    type: NCW_MESSAGE_TYPES.SUBTITLE_OFF,
                    movieId: currentVideoId,
                    timestamp: Date.now(),
                };
                window.postMessage(offPayload, '*');
            }
        } else {
            const lang = value.languageCode;
            const isAsr =
                value.kind === 'asr' ||
                (value.vssId ? value.vssId.startsWith('a.') : false);
            const trackKey = `${lang}_${isAsr ? 'asr' : 'normal'}`;

            record.activeTrackKey = trackKey;
            record.userExplicitlyDisabledCaptions = false;

            const cached =
                record.cachedSubtitles.get(trackKey) ||
                record.cachedSubtitles.get(lang);
            if (cached) {
                this.emitCachedSubtitle(cached, false);
            } else {
                this.trackRegistry.fetchAndCacheTrack(currentVideoId, value);
            }
        }
    }

    private emitCachedSubtitle(
        cached: YouTubeCachedSubtitle,
        isReplay = false,
    ): void {
        const record = this.trackRegistry.getVideoRecord(cached.videoId);
        const sig = `${cached.videoId}_${cached.trackKey}_${cached.rawText.length}`;
        record.lastEmittedSignature = sig;
        record.activeTrackKey = cached.trackKey;
        record.userExplicitlyDisabledCaptions = false;

        const payload: InjectedSubtitleRawDataPayload = {
            type: NCW_MESSAGE_TYPES.SUBTITLE_RAW_DATA,
            movieId: cached.videoId,
            url: cached.url,
            pageUrl: window.location.href,
            rawText: cached.rawText,
            bcp47: cached.languageCode,
            timestamp: Date.now(),
            isReplay,
            isAsr: cached.isAsr,
        };
        window.postMessage(payload, '*');
    }

    // --------------------------------------------------------------------------
    // 8. Message Listener (ISOLATED World -> MAIN World)
    // --------------------------------------------------------------------------

    private setupMessageListener(): void {
        const handler = async (event: MessageEvent) => {
            if (event.source !== window || !event.data) return;
            const data: InjectedIncomingEvent = event.data;

            // 8.1 Legacy Subtitle Retry (Backward Compatibility)
            if (data.type === NCW_MESSAGE_TYPES.REQUEST_SUBTITLE_RETRY) {
                this.handleRetryRequest();
            }

            // 8.2 Legacy Request Metadata (Backward Compatibility)
            if (data.type === NCW_MESSAGE_TYPES.REQUEST_METADATA) {
                this.emitMetadataForCurrentVideo();
            }

            // 8.3 Tri-State Query Metadata (Type 2)
            if (data.type === NCW_MESSAGE_TYPES.QUERY_METADATA) {
                const queryId = data.queryId;
                const targetVid =
                    data.movieId ||
                    this.getCurrentVideoId();

                const respond = (
                    status: 'resolved' | 'null' | 'undefined',
                    metadata?: VideoMetadata,
                ) => {
                    window.postMessage(
                        {
                            type: NCW_MESSAGE_TYPES.QUERY_METADATA_RESULT,
                            queryId,
                            status,
                            movieId: targetVid || undefined,
                            metadata,
                        },
                        '*',
                    );
                };

                if (!targetVid) {
                    respond('undefined');
                    return;
                }

                let title = '';
                let channelName = '';
                let description = '';

                const player = this.getPlayerElement();
                if (player && typeof player.getVideoData === 'function') {
                    try {
                        const vData = player.getVideoData();
                        if (vData) {
                            if (vData.video_id && vData.video_id !== targetVid) {
                                respond('undefined');
                                return;
                            }
                            if (vData.title) title = vData.title;
                            if (vData.author) channelName = vData.author;
                        }
                    } catch {}
                }

                if (!title && window.ytInitialPlayerResponse?.videoDetails) {
                    const details = window.ytInitialPlayerResponse.videoDetails;
                    if (details.videoId === targetVid) {
                        if (details.title) title = details.title;
                        if (details.author) channelName = details.author;
                        if (details.shortDescription) description = details.shortDescription;
                    }
                }

                if (!title) {
                    title = document.title
                        ? document.title.replace(/\s*-\s*YouTube$/i, '').trim()
                        : '';
                }

                if (title) {
                    const meta: VideoMetadata = {
                        mainTitle: title,
                        episodeTitle: '',
                        fullTitle: title,
                        videoId: targetVid,
                        showId: targetVid,
                        showSummary: channelName ? `Channel: ${channelName}` : description || undefined,
                    };
                    respond('resolved', meta);
                } else {
                    respond('undefined');
                }
            }

            // 8.4 Tri-State Query Subtitle (Type 2)
            if (data.type === NCW_MESSAGE_TYPES.QUERY_SUBTITLE) {
                const queryId = data.queryId;
                const targetVid =
                    data.movieId ||
                    this.getCurrentVideoId();

                const respond = (
                    status: 'resolved' | 'null' | 'undefined',
                    payload?: { rawText: string; bcp: string },
                ) => {
                    window.postMessage(
                        {
                            type: NCW_MESSAGE_TYPES.QUERY_SUBTITLE_RESULT,
                            queryId,
                            status,
                            movieId: targetVid || undefined,
                            rawText: payload?.rawText,
                            bcp: payload?.bcp,
                        },
                        '*',
                    );
                };

                if (!targetVid) {
                    respond('undefined');
                    return;
                }

                const result = await this.trackRegistry.getTrack(targetVid, this.getPlayerElement());

                if (result.status === 'resolved' && result.subtitle) {
                    respond('resolved', {
                        rawText: result.subtitle.rawText,
                        bcp: result.subtitle.languageCode,
                    });
                } else if (result.status === 'null') {
                    respond('null');
                } else {
                    respond('undefined');
                }
            }

            // 8.5 Native Track Query
            if (data.type === NCW_MESSAGE_TYPES.QUERY_NATIVE_TRACK) {
                this.handleQueryNativeTrack(data.movieId, data.targetLangCode);
            }
        };

        window.addEventListener('message', handler);
        this.cleanupMessageListener = () => {
            window.removeEventListener('message', handler);
        };
    }

    private handleRetryRequest(): void {
        const currentVideoId = this.getCurrentVideoId();
        if (!currentVideoId) return;

        const record = this.trackRegistry.getVideoRecord(currentVideoId);
        if (record.cachedSubtitles.size > 0) {
            const targetCached =
                (record.activeTrackKey &&
                    record.cachedSubtitles.get(record.activeTrackKey)) ||
                record.cachedSubtitles.values().next().value;
            if (targetCached) {
                this.emitCachedSubtitle(targetCached, true);
                return;
            }
        }

        this.trackRegistry.refreshVideoTracks(currentVideoId, this.getPlayerElement());
        if (record.tracks.length > 0) {
            const player = this.getPlayerElement();
            const current =
                typeof player?.getOption === 'function'
                    ? (player.getOption('captions', 'track') as { languageCode?: string } | null)
                    : null;
            const targetTrack =
                (current &&
                    current.languageCode &&
                    record.tracks.find((t) => t.languageCode === current.languageCode)) ||
                record.tracks[0];

            if (targetTrack) {
                this.trackRegistry.fetchAndCacheTrack(currentVideoId, targetTrack);
            }
        }
    }

    private async handleQueryNativeTrack(
        movieId: string,
        targetLangCode: string,
    ): Promise<void> {
        const effectiveVideoId = movieId || this.getCurrentVideoId() || '';
        if (!effectiveVideoId || !targetLangCode) {
            this.sendNativeTrackNotFound(effectiveVideoId, targetLangCode);
            return;
        }

        const cached = await this.trackRegistry.checkAndCacheNativeTargetTrack(
            effectiveVideoId,
            targetLangCode,
            this.getPlayerElement(),
        );

        if (cached && cached.rawText) {
            const payload: InjectedNativeTrackDataPayload = {
                type: NCW_MESSAGE_TYPES.NATIVE_TRACK_DATA,
                movieId: effectiveVideoId,
                found: true,
                bcp47: cached.languageCode,
                rawText: cached.rawText,
                targetLangCode,
            };
            window.postMessage(payload, '*');
        } else {
            this.sendNativeTrackNotFound(effectiveVideoId, targetLangCode);
        }
    }

    private sendNativeTrackNotFound(
        movieId: string,
        targetLangCode: string,
    ): void {
        const notFoundPayload: InjectedNativeTrackDataPayload = {
            type: NCW_MESSAGE_TYPES.NATIVE_TRACK_DATA,
            movieId,
            found: false,
            targetLangCode,
        };
        window.postMessage(notFoundPayload, '*');
    }
}
