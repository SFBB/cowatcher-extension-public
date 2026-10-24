import {
    IStreamingAdapter,
    VideoMetadata,
} from '../../domain/adapters/IStreamingAdapter';
import { ContentMessageService } from '../services/ContentMessageService';
import { WatchSession } from '@shared/domain/entities/WatchHistory';
import { Logger } from '@shared/utils/logger';
import { startTriStatePoll, PollHandle } from '../utils/pollHelper';

export class WatchHistoryTracker {
    private readonly adapter: IStreamingAdapter;
    private readonly messageService: ContentMessageService;
    private readonly logger: Logger = new Logger('WatchHistoryTracker');

    // Tri-state metadata:
    // - VideoMetadata: Confirmed metadata loaded
    // - null: Confirmed standalone video without episodic show metadata
    // - undefined: Unknown / pending (in-flight or in transition, caller schedules retry)
    private currentMetadata: VideoMetadata | null | undefined = undefined;
    private currentMovieId: string | null = null;
    private metadataPollHandle: PollHandle<VideoMetadata> | null = null;
    private metadataAbortController: AbortController | null = null;

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
        this.currentMovieId = newIdStr;
        this.currentSessionId = null;
        this.effectiveWatchSeconds = 0;
        this.currentMetadata = undefined; // reset to pending
        if (this.metadataPollHandle) {
            this.metadataPollHandle.stop();
            this.metadataPollHandle = null;
        }
        if (this.metadataAbortController) {
            this.metadataAbortController.abort();
            this.metadataAbortController = null;
        }

        if (newIdStr) {
            this.resolveMetadata(newIdStr);
        }
    }

    onMetadataLoaded(meta: VideoMetadata): void {
        if (!meta) return;

        // Input consistency check: If metadata has videoId, it MUST match currentMovieId
        if (
            this.currentMovieId &&
            meta.videoId &&
            meta.videoId !== this.currentMovieId
        ) {
            this.logger.warn(
                'Tracker',
                `Dropped metadata for ${meta.videoId} because currentMovieId is ${this.currentMovieId}. Inconsistency strictly prevented.`,
            );
            return;
        }

        // If metadata does not contain videoId, bound to currentMovieId
        if (!meta.videoId && this.currentMovieId) {
            meta = { ...meta, videoId: this.currentMovieId };
        }

        // If switching to a different episode or show, flush previous session first
        if (
            this.currentMetadata &&
            (this.currentMetadata.videoId !== meta.videoId ||
                this.currentMetadata.showId !== meta.showId)
        ) {
            this.flushSession(false);
        }

        this.currentMetadata = meta;
    }

    async resolveMetadata(
        movieId?: string,
    ): Promise<VideoMetadata | null | undefined> {
        const targetMovieId = movieId || this.currentMovieId || undefined;
        if (!targetMovieId) return this.currentMetadata;
        if (
            this.currentMetadata !== undefined &&
            this.currentMovieId === targetMovieId
        ) {
            return this.currentMetadata;
        }

        if (this.metadataPollHandle) {
            this.metadataPollHandle.stop();
            this.metadataPollHandle = null;
        }
        if (this.metadataAbortController) {
            this.metadataAbortController.abort();
            this.metadataAbortController = null;
        }

        const abortController = new AbortController();
        this.metadataAbortController = abortController;

        const handle = await startTriStatePoll(
            () => this.adapter.queryMetadata(targetMovieId),
            {
                immediate: true,
                intervalMs: 1200,
                maxAttempts: 15,
                timeoutMs: 60 * 1000,
                backoffFactor: 1.2,
                maxIntervalMs: 3000,
                abortSignal: abortController.signal,
                onSuccess: (result) => {
                    if (this.currentMovieId !== targetMovieId) return;
                    this.currentMetadata = result;
                    this.logger.info(
                        'Tracker',
                        `Metadata resolved via poll: ${result ? result.fullTitle : 'null (standalone video)'}`,
                    );
                },
            },
        );

        this.metadataPollHandle = handle;
        if (handle.initialResult !== undefined) {
            if (this.currentMovieId === targetMovieId) {
                this.currentMetadata = handle.initialResult;
            }
            return handle.initialResult;
        }

        return undefined;
    }

    private onPlay(): void {
        this.isPlaying = true;
        const now = Date.now();
        const fallbackTime = this.boundVideo?.currentTime || 0;

        if (!this.currentSessionId) {
            this.currentSessionId = `ws_${now}_${Math.random().toString(36).slice(2, 7)}`;
            this.sessionStartedAt = now;
            this.fromContentTime = fallbackTime;
            this.lastContentTime = fallbackTime;
            this.effectiveWatchSeconds = 0;
        }

        this.lastWallClockTick = now;

        this.adapter.getContentTime().then((ct) => {
            if (ct !== undefined && ct !== null) {
                this.fromContentTime = ct;
                this.lastContentTime = ct;
            }
        }).catch(() => {});

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
        const fallbackTime = this.boundVideo?.currentTime || 0;
        this.fromContentTime = fallbackTime;
        this.lastContentTime = fallbackTime;
        this.effectiveWatchSeconds = 0;
        this.lastWallClockTick = Date.now();

        this.adapter.getContentTime().then((ct) => {
            if (ct !== undefined && ct !== null) {
                this.fromContentTime = ct;
                this.lastContentTime = ct;
            }
        }).catch(() => {});

        if (this.boundVideo && !this.boundVideo.paused) {
            this.onPlay();
        }
    }

    private onTick(): void {
        if (!this.isPlaying) return;

        const now = Date.now();
        const currentContentTime = this.boundVideo?.currentTime || 0;
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
                'Flush deferred: metadata is undefined (pending). Scheduling active query retry.',
            );
            this.resolveMetadata();
            return;
        }

        // Verify entity consistency: if metadata videoId doesn't match currentMovieId, don't record wrong video!
        if (
            this.currentMetadata &&
            this.currentMovieId &&
            this.currentMetadata.videoId &&
            this.currentMetadata.videoId !== this.currentMovieId
        ) {
            this.logger.warn(
                'Tracker',
                `Consistency violation prevented on flush: metadata ${this.currentMetadata.videoId} !== ${this.currentMovieId}. Invalidation triggered.`,
            );
            this.currentMetadata = undefined;
            return;
        }

        // Determine showId, showTitle, videoId based on concrete data or null (standalone)
        let meta = this.currentMetadata;
        let showId: string;
        let showTitle: string;
        let videoId: string;

        if (meta === null) {
            // Confirmed standalone title
            videoId = this.currentMovieId || this.adapter.extractVideoId() || 'standalone_video';
            showId = videoId;
            showTitle = 'Standalone Video';
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
        if (this.metadataPollHandle) {
            this.metadataPollHandle.stop();
            this.metadataPollHandle = null;
        }
        if (this.metadataAbortController) {
            this.metadataAbortController.abort();
            this.metadataAbortController = null;
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
