import {
  IStreamingAdapter,
  SubtitleCueData,
  VideoMetadata,
  IAdDetector,
  AdDetectorOptions,
} from '../../../domain/adapters/IStreamingAdapter';
import { SubtitleParser } from '../../../application/utils/parser';
import { YouTubeSubtitleParser } from './YouTubeSubtitleParser';
import { YouTubeAdDetector } from './YouTubeAdDetector';
import { STREAMING_PLATFORMS } from '@shared/domain/constants/StreamingPlatforms';
import { NCW_MESSAGE_TYPES } from '@shared/domain/constants/MessageTypes';
import { Logger } from '@shared/utils/logger';

export class YouTubeContentAdapter implements IStreamingAdapter {
  readonly platformName = STREAMING_PLATFORMS.YOUTUBE;
  private adDetector: YouTubeAdDetector;
  private messageListeners: Array<(event: MessageEvent) => void> = [];
  private cachedMetadata?: VideoMetadata;
  private currentMovieId: string | null = null;
  private readonly logger: Logger = new Logger('YouTubeContentAdapter');

  constructor() {
    this.adDetector = new YouTubeAdDetector();
    this.currentMovieId = this.extractVideoId();
  }

  createAdDetector(options?: AdDetectorOptions): IAdDetector {
    if (this.adDetector) {
      this.adDetector.stopMonitoring();
    }
    this.adDetector = new YouTubeAdDetector(options);
    return this.adDetector;
  }

  matches(url: string): boolean {
    return /youtube\.com/i.test(url);
  }

  extractVideoId(url: string = window.location.href): string | null {
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

    if (this.cachedMetadata?.videoId) return this.cachedMetadata.videoId;
    return null;
  }

  isPlaybackPage(url: string = window.location.href): boolean {
    if (this.extractVideoId(url)) return true;
    return (
      /\/watch(\/|\?|$)/i.test(url) ||
      url.includes('/shorts/') ||
      url.includes('/live/') ||
      url.includes('/embed/')
    );
  }

  getVideoInfo(): VideoMetadata {
    if (this.cachedMetadata) {
      return this.cachedMetadata;
    }

    const videoId = this.extractVideoId() || '';

    // Try finding YouTube watch title from DOM elements
    const titleEl =
      document.querySelector('h1.ytd-watch-metadata yt-formatted-string') ||
      document.querySelector('#title h1 yt-formatted-string') ||
      document.querySelector('h1.title yt-formatted-string') ||
      document.querySelector('h1.ytd-video-primary-info-renderer');

    let mainTitle = titleEl?.textContent?.trim() || '';

    if (!mainTitle) {
      mainTitle = typeof document !== 'undefined' ? document.title || '' : '';
      mainTitle = mainTitle.replace(/\s*-\s*YouTube$/i, '').trim();
    }

    // Try finding channel/author name
    const channelEl =
      document.querySelector('#channel-name a') ||
      document.querySelector('ytd-channel-name a') ||
      document.querySelector('#owner #channel-name');
    const channelName = channelEl?.textContent?.trim() || '';

    return {
      mainTitle,
      episodeTitle: '',
      fullTitle: mainTitle,
      videoId,
      showId: videoId,
      showSummary: channelName ? `Channel: ${channelName}` : undefined,
    };
  }

  getVideoElement(): HTMLVideoElement | null {
    return (
      (document.querySelector('#movie_player video') as HTMLVideoElement | null) ||
      (document.querySelector('video.html5-main-video') as HTMLVideoElement | null) ||
      document.querySelector('video')
    );
  }

  getPlayerContainer(): HTMLElement | null {
    const candidate =
      document.getElementById('movie_player') ||
      (document.querySelector('.html5-video-player') as HTMLElement | null) ||
      (document.querySelector('ytd-reel-video-renderer[is-active]') as HTMLElement | null) ||
      (document.querySelector('#player') as HTMLElement | null) ||
      (document.querySelector('video')?.parentElement as HTMLElement | null) ||
      null;

    if (candidate && candidate !== document.body) {
      return candidate;
    }
    return null;
  }

  getContentTime(): number {
    const video = this.getVideoElement();
    return video ? video.currentTime : 0;
  }

  isAdActive(): boolean {
    return this.adDetector.isAdPlaying;
  }

  pausePlayback(): void {
    try {
      const ytPlayer = document.getElementById('movie_player') as any;
      if (ytPlayer && typeof ytPlayer.pauseVideo === 'function') {
        ytPlayer.pauseVideo();
        return;
      }
    } catch {
      // Fallback below
    }
    const video = this.getVideoElement();
    if (video && !video.paused) {
      video.pause();
    }
  }

  resumePlayback(): void {
    try {
      const ytPlayer = document.getElementById('movie_player') as any;
      if (ytPlayer && typeof ytPlayer.playVideo === 'function') {
        ytPlayer.playVideo();
        return;
      }
    } catch {
      // Fallback below
    }
    const video = this.getVideoElement();
    if (video && video.paused) {
      video.play().catch(() => {});
    }
  }

  isPlaybackPaused(): boolean {
    try {
      const ytPlayer = document.getElementById('movie_player') as any;
      if (ytPlayer && typeof ytPlayer.getPlayerState === 'function') {
        return ytPlayer.getPlayerState() === 2;
      }
    } catch {
      // Fallback below
    }
    const video = this.getVideoElement();
    return video ? video.paused : true;
  }

  onEpisodeChange(callback: (newEpisodeId: string) => void): () => void {
    const listener = (event: MessageEvent) => {
      if (event.source !== window || !event.data) return;
      if (event.data.type === NCW_MESSAGE_TYPES.EPISODE_CHANGED && event.data.movieId) {
        const newId = String(event.data.movieId);
        if (newId !== this.currentMovieId) {
          this.currentMovieId = newId;
          this.clearMetadata();
          callback(newId);
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
        const newUrl = event.data.url;
        const newId = this.extractVideoId(newUrl);
        if (newId && newId !== this.currentMovieId) {
          this.currentMovieId = newId;
          this.clearMetadata();
        }
        callback(newUrl);
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
        const d = event.data;
        const meta: VideoMetadata = {
          mainTitle: d.showTitle || '',
          episodeTitle: '',
          fullTitle: d.showTitle || '',
          videoId: d.showId || this.extractVideoId() || '',
          showId: d.showId,
          showSummary: d.showSynopsis,
        };
        this.cachedMetadata = meta;
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
      if (event.data.type === NCW_MESSAGE_TYPES.SUBTITLE_PRELOAD_STAGED && event.data.rawText) {
        callback({
          movieId: event.data.movieId,
          rawText: event.data.rawText,
          bcp47: event.data.bcp47,
          timestamp: event.data.timestamp,
        });
      }
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }

  parseSubtitle(rawText: string): SubtitleCueData[] {
    return YouTubeSubtitleParser.parse(rawText);
  }

  onSubtitleData(
    callback: (data: { cues: SubtitleCueData[]; language: string; movieId?: string; isAsr?: boolean }) => void
  ): () => void {
    const listener = (event: MessageEvent) => {
      if (event.source !== window || !event.data) return;
      if (event.data.type === NCW_MESSAGE_TYPES.SUBTITLE_RAW_DATA && event.data.rawText) {
        try {
          const cues = this.parseSubtitle(event.data.rawText);

          const language =
            event.data.bcp47 ||
            SubtitleParser.detectLanguage(event.data.rawText, cues) ||
            'en';

          const movieId = event.data.movieId || this.extractVideoId() || undefined;
          const isAsr = Boolean(event.data.isAsr);

          this.logger.info(
            'YouTube-AI-Sub',
            `Processed ${cues.length} subtitle cues (lang: ${language}, movieId: ${movieId}, isAsr: ${isAsr})`
          );

          callback({
            cues,
            language,
            movieId,
            isAsr,
          });
        } catch (err) {
          this.logger.error('YouTube-AI-Sub', 'Failed parsing YouTube raw subtitle text:', err);
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
    this.logger.info('YouTube-AI-Sub', 'Requesting subtitle retry from YouTube Injected Adapter.');
    window.postMessage({ type: NCW_MESSAGE_TYPES.REQUEST_SUBTITLE_RETRY }, '*');
  }

  requestMetadata(movieId?: string): void {
    window.postMessage({ type: NCW_MESSAGE_TYPES.REQUEST_METADATA, movieId }, '*');
  }

  async queryMetadata(movieId?: string): Promise<VideoMetadata | null | undefined> {
    const queryId = `qm_yt_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const effectiveMid = movieId || this.extractVideoId() || undefined;

    return new Promise<VideoMetadata | null | undefined>((resolve) => {
      let resolved = false;
      let timer: any = null;

      const handler = (event: MessageEvent) => {
        if (event.source !== window || !event.data) return;
        if (
          event.data.type === NCW_MESSAGE_TYPES.QUERY_METADATA_RESULT &&
          event.data.queryId === queryId
        ) {
          resolved = true;
          clearTimeout(timer);
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
        '*'
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

  clearMetadata(): void {
    this.cachedMetadata = undefined;
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
                const cues = this.parseSubtitle(event.data.rawText);
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
      timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, 5000);

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
    this.messageListeners.forEach((listener) => window.removeEventListener('message', listener));
    this.messageListeners = [];
    if (this.adDetector) {
      this.adDetector.stopMonitoring();
    }
  }
}
