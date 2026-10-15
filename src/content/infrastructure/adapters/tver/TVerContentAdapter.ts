import {
  IStreamingAdapter,
  SubtitleCueData,
  VideoMetadata,
  IAdDetector,
  AdDetectorOptions,
} from '../../../domain/adapters/IStreamingAdapter';
import { SubtitleParser } from '../../../application/utils/parser';
import { TVerAdDetector } from './TVerAdDetector';
import { STREAMING_PLATFORMS } from '@shared/domain/constants/StreamingPlatforms';
import { NCW_MESSAGE_TYPES } from '@shared/domain/constants/MessageTypes';
import { Logger } from '@shared/utils/logger';

export class TVerContentAdapter implements IStreamingAdapter {
  readonly platformName = STREAMING_PLATFORMS.TVER;
  private adDetector: TVerAdDetector;
  private messageListeners: Array<(event: MessageEvent) => void> = [];
  private cachedMetadata?: VideoMetadata;
  private readonly logger: Logger = new Logger('TVerContentAdapter');

  constructor() {
    this.adDetector = new TVerAdDetector();
  }

  createAdDetector(options?: AdDetectorOptions): IAdDetector {
    if (this.adDetector) {
      this.adDetector.stopMonitoring();
    }
    this.adDetector = new TVerAdDetector(options);
    return this.adDetector;
  }

  matches(url: string): boolean {
    return /tver\.jp/i.test(url);
  }

  extractVideoId(url: string = window.location.href): string | null {
    const match = (url || '').match(/\/episodes\/([a-zA-Z0-9_-]+)/);
    if (match) return match[1];
    if (this.cachedMetadata?.videoId) return this.cachedMetadata.videoId;
    return null;
  }

  getVideoInfo(): VideoMetadata {
    if (this.cachedMetadata) {
      return this.cachedMetadata;
    }

    const ds =
      typeof document !== 'undefined' && document.documentElement
        ? document.documentElement.dataset
        : undefined;

    if (ds && (ds.ncwMainTitle || ds.ncwShowId)) {
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
        videoId: this.extractVideoId() || '',
        showId: ds.ncwShowId,
        seasonId: ds.ncwSeasonId,
        showSummary: ds.ncwShowSummary,
        episodeSummary: ds.ncwEpisodeSummary,
      };
    }

    // Fallback: parse from page document title (e.g. "VIVANT 第二十話 ... | TVer")
    let rawTitle = typeof document !== 'undefined' ? document.title || '' : '';
    rawTitle = rawTitle.replace(/\s*\|\s*TVer.*$/i, '').trim();

    return {
      mainTitle: rawTitle,
      episodeTitle: '',
      fullTitle: rawTitle,
      videoId: this.extractVideoId() || '',
    };
  }

  getVideoElement(): HTMLVideoElement | null {
    return (
      (document.getElementById('video-player') as HTMLVideoElement | null) ||
      document.querySelector('video')
    );
  }

  getPlayerContainer(): HTMLElement | null {
    return (
      document.querySelector('[class*="Episode_player"]') ||
      document.querySelector('[class*="MiniPlayerLayout_player"]') ||
      document.getElementById('video-player')?.parentElement ||
      document.querySelector('video')?.parentElement ||
      document.body
    );
  }

  getContentTime(): number {
    const video = this.getVideoElement();
    if (!video) return 0;

    // Use atomic presentation time from StreaksPlayer currentTimeWithoutAdPlayer if available
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
            const now = performance.now();
            const elapsed = Math.max(0, now - syncAt);
            if (elapsed < 3000) {
              return isPaused ? baseTime : baseTime + (elapsed / 1000) * rate;
            }
          }
        }
      }
    }

    return video.currentTime || 0;
  }

  isAdActive(): boolean {
    return this.adDetector.isAdPlaying;
  }

  onEpisodeChange(callback: (newEpisodeId: string) => void): () => void {
    const listener = (event: MessageEvent) => {
      if (event.source !== window || !event.data) return;
      if (event.data.type === NCW_MESSAGE_TYPES.EPISODE_CHANGED) {
        const movieId = String(event.data.movieId || '');
        if (movieId) {
          this.logger.info('TVer-AI-Sub', `Episode change event received: ${movieId}`);
          callback(movieId);
        }
      }
    };
    window.addEventListener('message', listener);
    this.messageListeners.push(listener);
    return () => window.removeEventListener('message', listener);
  }

  onUrlChange(callback: (url: string) => void): () => void {
    const listener = (event: MessageEvent) => {
      if (event.source !== window || !event.data) return;
      if (event.data.type === NCW_MESSAGE_TYPES.URL_CHANGED && event.data.url) {
        callback(event.data.url);
      }
    };
    window.addEventListener('message', listener);
    this.messageListeners.push(listener);
    return () => window.removeEventListener('message', listener);
  }

  onTimeSync(
    callback: (offsets: { cadmiumOffset?: number; adOffset?: number }) => void
  ): () => void {
    const listener = (event: MessageEvent) => {
      if (event.source !== window || !event.data) return;
      if (event.data.type === NCW_MESSAGE_TYPES.TIME_SYNC) {
        callback({
          cadmiumOffset: event.data.cadmiumOffset || 0,
          adOffset: event.data.adOffset || 0,
        });
      }
    };
    window.addEventListener('message', listener);
    this.messageListeners.push(listener);
    return () => window.removeEventListener('message', listener);
  }

  onMetadataLoaded(callback: (metadata: VideoMetadata) => void): () => void {
    const listener = (event: MessageEvent) => {
      if (event.source !== window || !event.data) return;
      if (event.data.type === NCW_MESSAGE_TYPES.METADATA_LOADED) {
        const payload = event.data;
        const mainTitle = payload.showTitle || '';
        const episodeTitle = payload.currentEpisode?.episodeTitle || '';
        const fullTitle = episodeTitle
          ? mainTitle
            ? `${mainTitle} - ${episodeTitle}`
            : episodeTitle
          : mainTitle;

        const meta: VideoMetadata = {
          mainTitle,
          episodeTitle,
          fullTitle,
          videoId: payload.currentEpisode?.episodeId || this.extractVideoId() || '',
          showId: payload.showId,
          seasonId: payload.seasonId,
          showSummary: payload.showSynopsis,
          episodeSummary: payload.currentEpisode?.episodeSynopsis,
          seasonNum: payload.seasonSeq,
          episodeNum: payload.currentEpisode?.episodeSeq,
        };

        this.cachedMetadata = meta;
        this.logger.info(
          'TVer-AI-Sub',
          `Parsed VideoMetadata: "${fullTitle}" (showId: ${meta.showId})`
        );
        callback(meta);
      }
    };
    window.addEventListener('message', listener);
    this.messageListeners.push(listener);
    return () => window.removeEventListener('message', listener);
  }

  onSubtitlePreload(
    callback: (data: {
      movieId?: string;
      rawText: string;
      bcp47?: string | null;
      timestamp?: number;
    }) => void
  ): () => void {
    const listener = (event: MessageEvent) => {
      if (event.source !== window || !event.data) return;
      if (event.data.type === NCW_MESSAGE_TYPES.SUBTITLE_PRELOAD_STAGED) {
        callback({
          movieId: event.data.movieId,
          rawText: event.data.rawText,
          bcp47: event.data.bcp47,
          timestamp: event.data.timestamp,
        });
      }
    };
    window.addEventListener('message', listener);
    this.messageListeners.push(listener);
    return () => window.removeEventListener('message', listener);
  }

  onSubtitleData(
    callback: (data: { cues: SubtitleCueData[]; language: string; movieId?: string; isAsr?: boolean }) => void
  ): () => void {
    const listener = (event: MessageEvent) => {
      if (event.source !== window || !event.data) return;
      if (event.data.type === NCW_MESSAGE_TYPES.SUBTITLE_RAW_DATA) {
        const rawText = event.data.rawText;
        if (!rawText || typeof rawText !== 'string') return;

        try {
          const parsedCues = SubtitleParser.parse(rawText);
          if (parsedCues && parsedCues.length > 0) {
            const cues: SubtitleCueData[] = parsedCues.map((c: any) => ({
              id: c.id,
              start: c.start,
              end: c.end,
              text: c.text,
            }));

            const language =
              event.data.bcp47 || SubtitleParser.detectLanguage(rawText, parsedCues) || 'ja';

            this.logger.info(
              'TVer-AI-Sub',
              `Processed ${cues.length} subtitle cues (lang: ${language}, movieId: ${event.data.movieId})`
            );

            callback({
              cues,
              language,
              movieId: event.data.movieId,
              isAsr: false,
            });
          }
        } catch (err) {
          this.logger.error('TVer-AI-Sub', 'Failed parsing raw subtitle text:', err);
        }
      }
    };
    window.addEventListener('message', listener);
    this.messageListeners.push(listener);
    return () => window.removeEventListener('message', listener);
  }

  onSubtitleOff(callback: () => void): () => void {
    const listener = (event: MessageEvent) => {
      if (event.source !== window || !event.data) return;
      if (event.data.type === NCW_MESSAGE_TYPES.SUBTITLE_OFF) {
        callback();
      }
    };
    window.addEventListener('message', listener);
    this.messageListeners.push(listener);
    return () => window.removeEventListener('message', listener);
  }

  requestSubtitleRetry(): void {
    this.logger.info('TVer-AI-Sub', 'Posting REQUEST_SUBTITLE_RETRY to TVer injected adapter.');
    window.postMessage({ type: NCW_MESSAGE_TYPES.REQUEST_SUBTITLE_RETRY }, '*');
  }

  requestMetadata(movieId?: string): void {
    this.logger.info('TVer-AI-Sub', `Posting REQUEST_METADATA (${movieId || 'active'}) to TVer injected adapter.`);
    window.postMessage(
      {
        type: NCW_MESSAGE_TYPES.REQUEST_METADATA,
        movieId: movieId || this.extractVideoId() || undefined,
      },
      '*'
    );
  }

  clearMetadata(): void {
    this.cachedMetadata = undefined;
    if (typeof document !== 'undefined' && document.documentElement?.dataset) {
      delete document.documentElement.dataset.ncwShowId;
      delete document.documentElement.dataset.ncwMainTitle;
      delete document.documentElement.dataset.ncwEpisodeTitle;
    }
  }

  dispose(): void {
    this.adDetector.stopMonitoring();
    this.messageListeners.forEach((l) => window.removeEventListener('message', l));
    this.messageListeners = [];
  }
}
