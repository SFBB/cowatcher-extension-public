import {
  IStreamingAdapter,
  SubtitleCueData,
  VideoMetadata,
  IAdDetector,
  AdDetectorOptions,
} from '../../../domain/adapters/IStreamingAdapter';
import { SubtitleParser } from '../../../application/utils/parser';
import { NetflixAdDetector } from './NetflixAdDetector';
import { STREAMING_PLATFORMS } from '@shared/domain/constants/StreamingPlatforms';
import { NCW_MESSAGE_TYPES } from '@shared/domain/constants/MessageTypes';

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
      if (!currentVideoId || (this.cachedMetadata.videoId && this.cachedMetadata.videoId !== currentVideoId)) {
        this.cachedMetadata = undefined;
      } else {
        return this.cachedMetadata;
      }
    }
    const ds = typeof document !== 'undefined' && document.documentElement ? document.documentElement.dataset : undefined;
    if (currentVideoId && ds && (ds.ncwMainTitle || ds.ncwShowId)) {
      const mainTitle = ds.ncwMainTitle || '';
      const episodeTitle = ds.ncwEpisodeTitle || '';
      const fullTitle = episodeTitle ? (mainTitle ? `${mainTitle} - ${episodeTitle}` : episodeTitle) : mainTitle;
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
    return (
      document.querySelector('.watch-video--player-view') ||
      document.querySelector('[data-uia="watch-video"]') ||
      document.querySelector('.NFPlayer') ||
      document.querySelector('video')?.parentElement ||
      document.body
    );
  }

  getContentTime(): number {
    const video = this.getVideoElement();
    if (!video) return 0;

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
    return video.currentTime || 0;
  }

  isAdActive(): boolean {
    return Boolean(this.adDetector.isAdPlaying);
  }

  onEpisodeChange(callback: (newEpisodeId: string) => void): () => void {
    const handler = (event: MessageEvent) => {
      if (event.source !== window || !event.data) return;
      if (event.data.type === NCW_MESSAGE_TYPES.EPISODE_CHANGED && event.data.movieId) {
        const newEpId = String(event.data.movieId);
        if (this.cachedMetadata && this.cachedMetadata.videoId !== newEpId) {
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
      if (event.data.type === NCW_MESSAGE_TYPES.URL_CHANGED && event.data.url) {
        callback(event.data.url);
      }
    };
    window.addEventListener('message', handler);
    this.messageListeners.push(handler);
    return () => window.removeEventListener('message', handler);
  }

  onTimeSync(
    callback: (offsets: { cadmiumOffset?: number; adOffset?: number }) => void
  ): () => void {
    const handler = (event: MessageEvent) => {
      if (event.source !== window || !event.data) return;
      if (event.data.type === NCW_MESSAGE_TYPES.TIME_SYNC) {
        callback({
          cadmiumOffset:
            typeof event.data.cadmiumOffset === 'number' ? event.data.cadmiumOffset : undefined,
          adOffset: typeof event.data.adOffset === 'number' ? event.data.adOffset : undefined,
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
    }) => void
  ): () => void {
    const handler = (event: MessageEvent) => {
      if (event.source !== window || !event.data) return;
      if (event.data.type === NCW_MESSAGE_TYPES.SUBTITLE_PRELOAD_STAGED) {
        callback({
          movieId: event.data.movieId ? String(event.data.movieId) : undefined,
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

  onSubtitleData(
    callback: (data: { cues: SubtitleCueData[]; language: string; movieId?: string; isAsr?: boolean }) => void
  ): () => void {
    const handler = (event: MessageEvent) => {
      if (event.source !== window || !event.data) return;
      if (event.data.type === NCW_MESSAGE_TYPES.SUBTITLE_RAW_DATA && event.data.rawText) {
        try {
          const parsedCues = SubtitleParser.parse(event.data.rawText);
          const lang =
            event.data.bcp47 || SubtitleParser.detectLanguage(event.data.rawText, parsedCues);
          const cues: SubtitleCueData[] = parsedCues.map((c: any) => ({
            id: c.id,
            start: c.start,
            end: c.end,
            text: c.text,
            position: c.position,
          }));
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

  onSubtitleOff(callback: () => void): () => void {
    const handler = (event: MessageEvent) => {
      if (event.source !== window || !event.data) return;
      if (event.data.type === NCW_MESSAGE_TYPES.SUBTITLE_OFF) {
        callback();
      }
    };
    window.addEventListener('message', handler);
    this.messageListeners.push(handler);
    return () => window.removeEventListener('message', handler);
  }

  requestSubtitleRetry(): void {
    window.postMessage({ type: NCW_MESSAGE_TYPES.REQUEST_SUBTITLE_RETRY }, '*');
  }

  requestMetadata(movieId?: string): void {
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
      delete document.documentElement.dataset.ncwShowSummary;
      delete document.documentElement.dataset.ncwSeasonId;
      delete document.documentElement.dataset.ncwEpisodeTitle;
      delete document.documentElement.dataset.ncwEpisodeSummary;
    }
  }

  async fetchNativeTargetTrack(
    targetLang: import('@shared/domain/value-objects/Language').LanguageInfo,
    movieId?: string
  ): Promise<SubtitleCueData[] | null> {
    const effectiveMid = movieId || this.extractVideoId() || '';
    const langCode = targetLang?.code || 'en';

    return new Promise<SubtitleCueData[] | null>((resolve) => {
      let resolved = false;
      let timer: any = null;

      const handler = (event: MessageEvent) => {
        if (event.source !== window || !event.data) return;
        if (event.data.type === NCW_MESSAGE_TYPES.NATIVE_TRACK_DATA) {
          if (
            event.data.movieId === effectiveMid &&
            (event.data.targetLangCode === langCode || !event.data.targetLangCode)
          ) {
            cleanup();
            if (event.data.found && event.data.rawText) {
              try {
                const parsed = SubtitleParser.parse(event.data.rawText);
                const cues: SubtitleCueData[] = parsed.map((c: any) => ({
                  id: c.id,
                  start: c.start,
                  end: c.end,
                  text: c.text,
                  position: c.position,
                }));
                resolve(cues);
              } catch {
                resolve(null);
              }
            } else {
              resolve(null);
            }
          }
        }
      };

      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        if (timer) clearTimeout(timer);
        window.removeEventListener('message', handler);
      };

      window.addEventListener('message', handler);
      this.messageListeners.push(handler);

      // Timeout after 3.5 seconds
      timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, 3500);

      window.postMessage(
        {
          type: NCW_MESSAGE_TYPES.QUERY_NATIVE_TRACK,
          movieId: effectiveMid,
          targetLangCode: langCode,
        },
        '*'
      );
    });
  }

  dispose(): void {
    this.adDetector.stopMonitoring();
    this.messageListeners.forEach((fn) => window.removeEventListener('message', fn));
    this.messageListeners = [];
  }
}
