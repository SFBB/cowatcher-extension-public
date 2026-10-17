import { IStreamingAdapter, VideoMetadata } from '../../domain/adapters/IStreamingAdapter';
import { ContentMessageService } from '../services/ContentMessageService';
import { WatchSession } from '@shared/domain/entities/WatchHistory';
import { Logger } from '@shared/utils/logger';

export class WatchHistoryTracker {
  private readonly adapter: IStreamingAdapter;
  private readonly messageService: ContentMessageService;
  private readonly logger: Logger = new Logger('WatchHistoryTracker');

  private currentMetadata?: VideoMetadata;
  private currentSessionId: string | null = null;
  private sessionStartedAt: number = 0;
  private fromContentTime: number = 0;
  private lastContentTime: number = 0;
  private effectiveWatchSeconds: number = 0;
  private lastWallClockTick: number = 0;
  private isPlaying: boolean = false;

  private heartbeatInterval: any = null;
  private boundVideo: HTMLVideoElement | null = null;

  constructor(adapter: IStreamingAdapter, messageService: ContentMessageService) {
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

  onMetadataLoaded(meta: VideoMetadata): void {
    if (!meta) return;

    // If switching to a different episode or show, flush previous session first
    if (
      this.currentMetadata &&
      (this.currentMetadata.videoId !== meta.videoId || this.currentMetadata.showId !== meta.showId)
    ) {
      this.flushSession(false);
    }

    this.currentMetadata = meta;
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

    const contentDelta = Math.abs(currentContentTime - this.lastContentTime);

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

    const meta = this.currentMetadata;
    const showId = meta?.showId || meta?.videoId;
    if (!showId) return;

    // Discard negligible blips under 3 seconds
    if (this.effectiveWatchSeconds < 3) {
      if (!isOngoing) {
        this.currentSessionId = null;
        this.effectiveWatchSeconds = 0;
      }
      return;
    }

    const duration = this.boundVideo?.duration || this.adapter.getVideoElement()?.duration || 0;

    const session: WatchSession = {
      id: this.currentSessionId,
      platform: this.adapter.platformName || 'unknown',
      showId,
      showTitle: meta?.fullTitle || meta?.mainTitle || 'Unknown Show',
      seasonNum: meta?.seasonNum,
      episodeNum: meta?.episodeNum,
      episodeTitle: meta?.episodeTitle,
      videoId: meta?.videoId || showId,
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
