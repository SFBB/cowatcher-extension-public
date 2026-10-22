import {
  NetflixPlayer,
  NetflixInternalPlayer,
  NetflixTimedTextTrack,
  NetflixPlayerTextTrack,
} from './NetflixTypes';
import { Logger } from '@shared/utils/logger';

export interface NetflixPlayerBridgeHandlers {
  readonly onAdStateChange?: (isAd: boolean) => void;
  readonly onEpisodeChange?: (movieId: string, sessionId: string, url: string) => void;
  readonly onTimeSync?: (payload: {
    segmentTime: number;
    syncAt: number;
    isPaused: boolean;
    playbackRate: number;
  }) => void;
  readonly onSubtitleTrackChange?: (
    track: NetflixTimedTextTrack,
    isOff: boolean,
  ) => void;
}

export class NetflixPlayerBridge {
  private readonly logger = new Logger('NetflixPlayerBridge');

  private lastObservedMovieId: string | null = null;
  private lastObservedAdState = false;
  private lastObservedTrackId: string | null = null;
  private lastTimeUpdateSync = 0;
  private checkIntervalTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly handlers: NetflixPlayerBridgeHandlers) {}

  start(): void {
    this.stop();
    window.addEventListener('seeked', this.onVideoStateChange, { capture: true, passive: true });
    window.addEventListener('playing', this.onVideoStateChange, { capture: true, passive: true });
    window.addEventListener('pause', this.onVideoStateChange, { capture: true, passive: true });
    window.addEventListener('ratechange', this.onVideoStateChange, { capture: true, passive: true });
    window.addEventListener('timeupdate', this.onTimeUpdate, { capture: true, passive: true });

    this.checkIntervalTimer = setInterval(() => {
      this.checkPlayerState();
    }, 1000);
  }

  stop(): void {
    if (this.checkIntervalTimer) {
      clearInterval(this.checkIntervalTimer);
      this.checkIntervalTimer = null;
    }
    window.removeEventListener('seeked', this.onVideoStateChange);
    window.removeEventListener('playing', this.onVideoStateChange);
    window.removeEventListener('pause', this.onVideoStateChange);
    window.removeEventListener('ratechange', this.onVideoStateChange);
    window.removeEventListener('timeupdate', this.onTimeUpdate);
  }

  // --------------------------------------------------------------------------
  // Authoritative Netflix Player Getters
  // --------------------------------------------------------------------------

  getActivePlayer(): NetflixPlayer | null {
    const vp = window.netflix?.appContext?.state?.playerApp?.getAPI()?.videoPlayer;
    if (!vp) return null;

    const sessions = vp.getAllPlayerSessionIds().filter(
      (s: string) => !s.includes('billboard') && !s.includes('preview-modal') && !s.includes('merch'),
    );
    if (sessions.length === 0) return null;

    return vp.getVideoPlayerBySessionId(sessions[0]);
  }

  getCurrentMovieId(): string | null {
    const player = this.getActivePlayer();
    if (!player) return null;
    return String(player.getMovieId());
  }

  getSegmentTime(): number {
    const player = this.getActivePlayer();
    return player ? player.getSegmentTime() : 0;
  }

  isPaused(): boolean {
    const player = this.getActivePlayer();
    return player ? player.isPaused() : false;
  }

  isAd(): boolean {
    const player = this.getActivePlayer();
    return player ? player.isAd() : false;
  }

  getPlaybackRate(): number {
    const player = this.getActivePlayer();
    return player ? player.getPlaybackRate() : 1;
  }

  getActiveTextTrack(): NetflixTimedTextTrack | null {
    const internalP = this.getInternalPlayer();
    if (!internalP) return null;
    return internalP.getTextTrack();
  }

  getAvailableTextTracks(): readonly NetflixTimedTextTrack[] {
    const internalP = this.getInternalPlayer();
    if (!internalP) return [];
    return internalP.getTextTrackList();
  }

  getPlayerTextTracks(): readonly NetflixPlayerTextTrack[] {
    const internalP = this.getInternalPlayer();
    if (!internalP) return [];
    return internalP.getPlayerTextTracks();
  }

  setTextTrack(track: NetflixTimedTextTrack): void {
    const internalP = this.getInternalPlayer();
    if (internalP) {
      internalP.setTextTrack(track);
    }
  }

  // --------------------------------------------------------------------------
  // Internal State Observers & Event Dispatchers
  // --------------------------------------------------------------------------

  private getInternalPlayer(): NetflixInternalPlayer | null {
    const player = this.getActivePlayer();
    if (!player) return null;
    return player.getInternalPlayer();
  }

  private onVideoStateChange = (): void => {
    this.checkPlayerState();
  };

  private onTimeUpdate = (): void => {
    const now = performance.now();
    if (now - this.lastTimeUpdateSync > 250) {
      this.lastTimeUpdateSync = now;
      this.checkPlayerState();
    }
  };

  private checkPlayerState(): void {
    const player = this.getActivePlayer();
    if (!player) return;

    this.checkAdState(player);
    if (player.isAd()) return;

    this.checkEpisodeChange(player);
    this.checkTrackChange();
    this.dispatchTimeSync(player);
  }

  private checkAdState(player: NetflixPlayer): void {
    const isAd = player.isAd();
    if (isAd !== this.lastObservedAdState) {
      this.lastObservedAdState = isAd;
      this.logger.info('Netflix', `Ad state changed: ${isAd}`);
      this.handlers.onAdStateChange?.(isAd);
    }
  }

  private checkEpisodeChange(player: NetflixPlayer): void {
    const movieId = String(player.getMovieId());
    if (movieId !== this.lastObservedMovieId) {
      this.lastObservedMovieId = movieId;
      this.logger.info('Netflix', `Episode changed to: ${movieId}`);
      this.handlers.onEpisodeChange?.(
        movieId,
        'watch-session',
        window.location.href,
      );
    }
  }

  private checkTrackChange(): void {
    const track = this.getActiveTextTrack();
    if (!track) return;

    const trackId = track.trackId;
    if (trackId !== this.lastObservedTrackId) {
      this.lastObservedTrackId = trackId;
      const isOff = track.isNoneTrack === true || track.bcp47 === null;
      this.logger.info('Netflix', `Track changed to ${trackId} (isOff=${isOff})`);
      this.handlers.onSubtitleTrackChange?.(track, isOff);
    }
  }

  private dispatchTimeSync(player: NetflixPlayer): void {
    const segmentTime = player.getSegmentTime();
    this.handlers.onTimeSync?.({
      segmentTime,
      syncAt: Date.now(),
      isPaused: player.isPaused(),
      playbackRate: player.getPlaybackRate(),
    });
  }
}
