import {
    IStreamingAdapter,
    VideoMetadata,
} from '../../domain/adapters/IStreamingAdapter';
import { ContentMessageService } from '../services/ContentMessageService';
import { WatchSession } from '@shared/domain/entities/WatchHistory';
import { Logger } from '@shared/utils/logger';

export class WatchHistoryTracker {
    private readonly adapter: IStreamingAdapter;
    private readonly messageService: ContentMessageService;
    private readonly logger: Logger = new Logger('WatchHistoryTracker');

    // Tri-state metadata:
    // - VideoMetadata: Confirmed metadata loaded
    // - null: Confirmed standalone video without episodic show metadata
    // - undefined: Unknown / pending (in-flight or in transition, caller schedules retry)
    private currentMetadata: VideoMetadata | null | undefined = undefined;
    private isResolvingMetadata: boolean = false;
    private pendingRetryTimer: any = null;
    private retryCount: number = 0;

    private currentSessionId: string | null = null;
    private sessionStartedAt: number = 0;
    private fromContentTime: number = 0;
    private lastContentTime: number = 0;
    private effectiveWatchSeconds: number = 0;
    private lastWallClockTick: number = 0;
    private isPlaying: boolean = false;

    private heartbeatInterval: any = null;
    private boundVideo: HTMLVideoElement | null = null;

    constructor(
        adapter: IStreamingAdapter,
        messageService: ContentMessageService,
    ) {
        this.adapter = adapter;
        this.messageService = messageService;

        this.onPlay = this.onPlay.bind(this);
        this.onPause = this.onPause.bind(this);
        this.onTick = this.onTick.bind(this);
        this.onSeeking = this.onSeeking.bind(this);
        this.onSeeked = this.onSeeked.bind(this);
        this.onPageUnload = this.onPageUnload.bind(this);

        // Listen for tab/window unload to safely flush final watch duration
        if (typeof window !== 'undefined') {
            window.addEventListener('beforeunload', this.onPageUnload);
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'hidden' && this.isPlaying) {
                    this.flushSession(true);
                }
            });
        }

        // Periodic heartbeat (every 30s) to persist long sessions safely against crashes
        this.heartbeatInterval = setInterval(() => {
            if (this.isPlaying && this.effectiveWatchSeconds >= 5) {
                this.flushSession(true);
            }
        }, 30000);
    }

    attachVideo(video: HTMLVideoElement): void {
        if (this.boundVideo === video) return;
        this.detachVideo();

        this.boundVideo = video;
        video.addEventListener('play', this.onPlay);
        video.addEventListener('pause', this.onPause);
        video.addEventListener('ended', this.onPause);
        video.addEventListener('timeupdate', this.onTick);
        video.addEventListener('seeking', this.onSeeking);
        video.addEventListener('seeked', this.onSeeked);

        if (!video.paused && !video.ended) {
            this.onPlay();
        }
    }

    detachVideo(): void {
        if (!this.boundVideo) return;
        this.flushSession(false);

        this.boundVideo.removeEventListener('play', this.onPlay);
        this.boundVideo.removeEventListener('pause', this.onPause);
        this.boundVideo.removeEventListener('ended', this.onPause);
        this.boundVideo.removeEventListener('timeupdate', this.onTick);
        this.boundVideo.removeEventListener('seeking', this.onSeeking);
        this.boundVideo.removeEventListener('seeked', this.onSeeked);
        this.boundVideo = null;
    }

    onEpisodeChange(newMovieId: string | null): void {
        const newIdStr = newMovieId ? String(newMovieId) : null;
        this.logger.info(
            'Tracker',
            `Episode change detected (${newIdStr || 'new'}).`,
        );

        // Flush previous session if it has watch time
        if (this.currentSessionId && this.effectiveWatchSeconds >= 3) {
            this.flushSession(false);
        }
        this.currentSessionId = null;
        this.effectiveWatchSeconds = 0;
        this.currentMetadata = undefined; // reset to pending
        this.retryCount = 0;
        if (this.pendingRetryTimer) {
            clearTimeout(this.pendingRetryTimer);
            this.pendingRetryTimer = null;
        }

        if (newIdStr) {
            this.resolveMetadata(newIdStr);
        }
    }

    onMetadataLoaded(meta: VideoMetadata): void {
        if (!meta) return;

        // If switching to a different episode or show, flush previous session first
        if (
            this.currentMetadata &&
            (this.currentMetadata.videoId !== meta.videoId ||
                this.currentMetadata.showId !== meta.showId)
        ) {
            this.flushSession(false);
        }

        this.currentMetadata = meta;
        this.retryCount = 0;
        if (this.pendingRetryTimer) {
            clearTimeout(this.pendingRetryTimer);
            this.pendingRetryTimer = null;
        }
    }

    async resolveMetadata(
        movieId?: string,
    ): Promise<VideoMetadata | null | undefined> {
        if (this.isResolvingMetadata) return this.currentMetadata;
        this.isResolvingMetadata = true;

        try {
            const result = await this.adapter.queryMetadata(movieId);
            this.isResolvingMetadata = false;

            if (result !== undefined) {
                // Tri-state: concrete VideoMetadata or null (confirmed standalone)
                this.retryCount = 0;
                if (this.pendingRetryTimer) {
                    clearTimeout(this.pendingRetryTimer);
                    this.pendingRetryTimer = null;
                }
                this.currentMetadata = result;
                this.logger.info(
                    'Tracker',
                    `Metadata resolved: ${result ? result.fullTitle : 'null (standalone video)'}`,
                );
                return result;
            } else {
                // Tri-state: undefined -> Unknown / pending, schedule retry
                this.scheduleRetry(movieId);
                return undefined;
            }
        } catch (e) {
            this.isResolvingMetadata = false;
            this.scheduleRetry(movieId);
            return undefined;
        }
    }

    private scheduleRetry(movieId?: string): void {
        if (this.pendingRetryTimer) return;
        if (this.retryCount >= 10) return;

        this.retryCount++;
        const delay = Math.min(1000 * Math.pow(1.4, this.retryCount), 5000);
        this.logger.debug(
            'Tracker',
            `Metadata status is undefined (pending). Scheduling retry #${this.retryCount} in ${Math.round(delay)}ms.`,
        );

        this.pendingRetryTimer = setTimeout(() => {
            this.pendingRetryTimer = null;
            if (this.isPlaying || this.currentSessionId) {
                this.resolveMetadata(movieId);
            }
        }, delay);
    }

    private onPlay(): void {
        this.isPlaying = true;
        const now = Date.now();
        const contentTime = this.adapter.getContentTime();

        if (!this.currentSessionId) {
            this.currentSessionId = `ws_${now}_${Math.random().toString(36).slice(2, 7)}`;
            this.sessionStartedAt = now;
            this.fromContentTime = contentTime;
            this.lastContentTime = contentTime;
            this.effectiveWatchSeconds = 0;
        }

        this.lastWallClockTick = now;

        // If metadata is still undefined, kick off resolution
        if (this.currentMetadata === undefined) {
            this.resolveMetadata();
        }
    }

    private onPause(): void {
        this.isPlaying = false;
        this.flushSession(false);
    }

    private onSeeking(): void {
        // If user is scrubbing/seeking, flush current segment before jump
        if (this.effectiveWatchSeconds >= 3) {
            this.flushSession(false);
        }
    }

    private onSeeked(): void {
        const contentTime = this.adapter.getContentTime();
        this.fromContentTime = contentTime;
        this.lastContentTime = contentTime;
        this.effectiveWatchSeconds = 0;
        this.lastWallClockTick = Date.now();

        if (this.boundVideo && !this.boundVideo.paused) {
            this.onPlay();
        }
    }

    private onTick(): void {
        if (!this.isPlaying) return;

        const now = Date.now();
        const currentContentTime = this.adapter.getContentTime();
        const wallDelta = (now - this.lastWallClockTick) / 1000;
        this.lastWallClockTick = now;

        const contentDelta = Math.abs(
            currentContentTime - this.lastContentTime,
        );

        // If sudden unexpected jump occurred (> 15 seconds), treat as a jump/skip
        if (contentDelta > 15) {
            this.flushSession(false);
            this.currentSessionId = `ws_${now}_${Math.random().toString(36).slice(2, 7)}`;
            this.sessionStartedAt = now;
            this.fromContentTime = currentContentTime;
            this.lastContentTime = currentContentTime;
            this.effectiveWatchSeconds = 0;
            return;
        }

        // Normal continuous playback: accumulate effective watch time
        if (wallDelta > 0 && wallDelta < 5) {
            this.effectiveWatchSeconds += Math.min(wallDelta, 2);
            this.lastContentTime = currentContentTime;
        }
    }

    private flushSession(isOngoing: boolean): void {
        if (!this.currentSessionId) return;

        // Discard negligible blips under 3 seconds
        if (this.effectiveWatchSeconds < 3) {
            if (!isOngoing) {
                this.currentSessionId = null;
                this.effectiveWatchSeconds = 0;
            }
            return;
        }

        // Tri-state check:
        // If undefined: metadata is unknown / pending.
        // Do NOT discard! Defer and retry query so we never drop the session or record garbage.
        if (this.currentMetadata === undefined) {
            this.logger.info(
                'Tracker',
                `Flush deferred: metadata is undefined (pending). Scheduling active query retry.`,
            );
            this.resolveMetadata();
            return;
        }

        // Determine showId, showTitle, videoId based on concrete data or null (standalone)
        let meta = this.currentMetadata;
        let showId: string;
        let showTitle: string;
        let videoId: string;

        if (meta === null) {
            // Confirmed standalone title
            videoId = this.adapter.extractVideoId() || 'standalone_video';
            showId = videoId;
            showTitle =
                this.adapter.getVideoInfo()?.mainTitle || 'Standalone Video';
        } else {
            showId = meta.showId || meta.videoId;
            showTitle = meta.fullTitle || meta.mainTitle || 'Unknown Show';
            videoId = meta.videoId || showId;
        }

        const duration =
            this.boundVideo?.duration ||
            this.adapter.getVideoElement()?.duration ||
            0;

        const session: WatchSession = {
            id: this.currentSessionId,
            platform: this.adapter.platformName || 'unknown',
            showId,
            showTitle,
            seasonNum: meta?.seasonNum,
            episodeNum: meta?.episodeNum,
            episodeTitle: meta?.episodeTitle,
            videoId,
            startedAt: this.sessionStartedAt,
            endedAt: Date.now(),
            fromContentTime: Math.max(0, Math.round(this.fromContentTime)),
            toContentTime: Math.max(0, Math.round(this.lastContentTime)),
            videoDuration: Math.round(duration),
            effectiveWatchSeconds: Math.round(this.effectiveWatchSeconds),
        };

        this.messageService.recordWatchSession(session).catch((err) => {
            this.logger.warn('Flush', 'Failed to record session:', err);
        });

        if (!isOngoing) {
            this.currentSessionId = null;
            this.effectiveWatchSeconds = 0;
        }
    }

    private onPageUnload(): void {
        if (this.isPlaying) {
            this.flushSession(false);
        }
    }

    destroy(): void {
        if (this.pendingRetryTimer) {
            clearTimeout(this.pendingRetryTimer);
            this.pendingRetryTimer = null;
        }
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
        if (typeof window !== 'undefined') {
            window.removeEventListener('beforeunload', this.onPageUnload);
        }
        this.detachVideo();
    }
}
