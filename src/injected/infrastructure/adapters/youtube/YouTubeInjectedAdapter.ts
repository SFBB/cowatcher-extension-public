import {
  IInjectedAdapter,
  InjectedSubtitleRawDataPayload,
  InjectedMetadataLoadedPayload,
  InjectedSubtitleOffPayload,
  InjectedAdStateChangedPayload,
  InjectedEpisodeChangedPayload,
  InjectedUrlChangedPayload,
  InjectedNativeTrackDataPayload,
} from '../../../domain/IInjectedAdapter';
import { STREAMING_PLATFORMS, StreamingPlatformId } from '@shared/domain/constants/StreamingPlatforms';
import { NCW_MESSAGE_TYPES } from '@shared/domain/constants/MessageTypes';
import { NetworkHook } from '../../network/NetworkHook';
import { Logger } from '@shared/utils/logger';

declare global {
  interface Window {
    __NCW_YOUTUBE_INTERCEPTOR_INITIALIZED__?: boolean;
    ytInitialPlayerResponse?: any;
    ytplayer?: any;
  }
}

export class YouTubeInjectedAdapter implements IInjectedAdapter {
  readonly platformId: StreamingPlatformId = STREAMING_PLATFORMS.YOUTUBE;
  private readonly logger: Logger = new Logger('YouTubeInjectedAdapter');

  private lastEmittedSignature: string = '';
  private lastInterceptedSubtitle: {
    videoId: string | null;
    url: string;
    text: string;
    lang: string;
    isAsr: boolean;
    timestamp: number;
  } | null = null;

  private lastReportedUrl: string = '';
  private lastObservedVideoId: string | null = null;
  private lastAdState: boolean = false;
  private pollIntervalId: NodeJS.Timeout | number | null = null;
  private messageListener: ((e: MessageEvent) => void) | null = null;
  private unhookNetwork?: () => void;
  private lastTrackSignature: string = '';

  matches(url: string): boolean {
    return /youtube\.com/i.test(url);
  }

  initialize(): void {
    if (window.__NCW_YOUTUBE_INTERCEPTOR_INITIALIZED__) return;
    window.__NCW_YOUTUBE_INTERCEPTOR_INITIALIZED__ = true;

    this.lastReportedUrl = window.location.href;
    this.lastObservedVideoId = this.extractVideoId(window.location.href);

    this.logger.info('YouTube-AI-Sub', 'Initializing YouTube Injected Adapter in MAIN world.');

    this.setupNetworkInterceptor();
    this.setupNavigationMonitoring();
    this.setupPlayerBridge();
    this.setupMessageListener();

    // Start background polling for status and ad changes
    this.pollIntervalId = setInterval(() => {
      this.checkUrlAndVideoChange();
      this.checkPlayerAdState();
      this.checkPlayerCaptionsState();
    }, 500);

    // Initial metadata extraction
    setTimeout(() => {
      this.emitMetadataForCurrentVideo();
      this.tryEmitInitialActiveCaptions();
    }, 800);
  }

  destroy(): void {
    if (this.pollIntervalId) {
      clearInterval(this.pollIntervalId);
      this.pollIntervalId = null;
    }
    if (this.messageListener) {
      window.removeEventListener('message', this.messageListener);
      this.messageListener = null;
    }
    if (this.unhookNetwork) {
      this.unhookNetwork();
      this.unhookNetwork = undefined;
    }
  }

  // --- Network Interception ---
  private setupNetworkInterceptor(): void {
    this.unhookNetwork = NetworkHook.onSubtitlePayload((url, text) => {
      if (!url.toLowerCase().includes('timedtext')) return;
      this.handleInterceptedSubtitle(url, text);
    });
  }

  private handleInterceptedSubtitle(url: string, text: string): void {
    try {
      const urlObj = new URL(url, window.location.origin);
      const videoId = urlObj.searchParams.get('v') || this.extractVideoId() || '';
      const lang = urlObj.searchParams.get('lang') || 'en';
      const kind = urlObj.searchParams.get('kind');
      const isAsr = kind === 'asr' || url.includes('kind=asr');

      const signature = `${videoId}_${lang}_${kind || 'normal'}_${text.length}`;
      if (signature === this.lastEmittedSignature) {
        return;
      }
      this.lastEmittedSignature = signature;

      this.lastInterceptedSubtitle = {
        videoId,
        url,
        text,
        lang,
        isAsr,
        timestamp: Date.now(),
      };

      this.logger.info(
        'YouTube-AI-Sub',
        `Captured timedtext subtitle for video ${videoId} (lang: ${lang}, isAsr: ${isAsr}, bytes: ${text.length})`
      );

      const payload: InjectedSubtitleRawDataPayload = {
        type: NCW_MESSAGE_TYPES.SUBTITLE_RAW_DATA,
        movieId: videoId,
        url,
        pageUrl: window.location.href,
        rawText: text,
        bcp47: lang,
        timestamp: Date.now(),
        isAsr,
      };

      window.postMessage(payload, '*');
    } catch (err) {
      this.logger.error('YouTube-AI-Sub', 'Error handling intercepted subtitle:', err);
    }
  }

  // --- Navigation & Route Monitoring ---
  private setupNavigationMonitoring(): void {
    // YouTube fires 'yt-navigate-finish' on document for in-app SPA transitions
    const onNavigate = () => {
      this.checkUrlAndVideoChange();
      setTimeout(() => {
        this.emitMetadataForCurrentVideo();
        this.tryEmitInitialActiveCaptions();
      }, 500);
    };

    document.addEventListener('yt-navigate-finish', onNavigate);
    window.addEventListener('popstate', onNavigate);
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
      this.lastEmittedSignature = '';
      this.lastTrackSignature = '';

      const epPayload: InjectedEpisodeChangedPayload = {
        type: NCW_MESSAGE_TYPES.EPISODE_CHANGED,
        movieId: currentVideoId,
        url: currentUrl,
      };
      window.postMessage(epPayload, '*');
      this.emitMetadataForCurrentVideo();
    }
  }

  // --- Metadata Extraction ---
  private emitMetadataForCurrentVideo(): void {
    const videoId = this.lastObservedVideoId || this.extractVideoId();
    if (!videoId) return;

    let title = '';
    let description = '';

    // 1. Try YouTube player API
    const player = this.getPlayerElement();
    if (player && typeof player.getVideoData === 'function') {
      try {
        const data = player.getVideoData();
        if (data && data.title) {
          title = data.title;
        }
      } catch {}
    }

    // 2. Try window.ytInitialPlayerResponse
    if (!title && window.ytInitialPlayerResponse?.videoDetails) {
      const details = window.ytInitialPlayerResponse.videoDetails;
      if (details.title) title = details.title;
      if (details.shortDescription) description = details.shortDescription;
    }

    // 3. Fallback to document title
    if (!title) {
      title = document.title ? document.title.replace(/\s*-\s*YouTube$/i, '').trim() : '';
    }

    if (title) {
      const metaPayload: InjectedMetadataLoadedPayload = {
        type: NCW_MESSAGE_TYPES.METADATA_LOADED,
        showId: videoId,
        showTitle: title,
        showSynopsis: description || undefined,
      };
      window.postMessage(metaPayload, '*');
    }
  }

  // --- Player State & Ad Detection ---
  private setupPlayerBridge(): void {
    const player = this.getPlayerElement();
    if (!player) return;

    try {
      if (typeof player.addEventListener === 'function') {
        player.addEventListener('onAdStateChange', (state: any) => {
          const isAd = Boolean(state === 1 || state === true);
          this.reportAdState(isAd);
        });

        player.addEventListener('onOptionChange', (option: string, value: any) => {
          if (option === 'captions') {
            this.handleCaptionsOptionChange(value);
          }
        });
      }
    } catch {}
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
        isAd = player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting');
      }
    }

    if (isAd !== this.lastAdState) {
      this.reportAdState(isAd);
    }
  }

  private reportAdState(isAd: boolean): void {
    if (isAd === this.lastAdState) return;
    this.lastAdState = isAd;

    const payload: InjectedAdStateChangedPayload = {
      type: NCW_MESSAGE_TYPES.AD_STATE_CHANGED,
      isAd,
    };
    window.postMessage(payload, '*');
  }

  // --- Captions ON/OFF Monitoring ---
  private checkPlayerCaptionsState(): void {
    const player = this.getPlayerElement();
    if (!player || typeof player.getOption !== 'function') return;

    try {
      const track = player.getOption('captions', 'track');
      const trackSig = track && track.languageCode ? `${track.languageCode}_${track.vssId || ''}` : 'none';

      if (trackSig !== this.lastTrackSignature) {
        this.lastTrackSignature = trackSig;
        if (trackSig === 'none') {
          // Captions were turned off by user in YouTube controls
          this.logger.info('YouTube-AI-Sub', 'YouTube captions disabled / turned off.');
          const offPayload: InjectedSubtitleOffPayload = {
            type: NCW_MESSAGE_TYPES.SUBTITLE_OFF,
            movieId: this.lastObservedVideoId,
            timestamp: Date.now(),
          };
          window.postMessage(offPayload, '*');
        } else {
          this.logger.info('YouTube-AI-Sub', `YouTube caption track active: ${trackSig}`);
          this.fetchAndEmitTrack(track);
        }
      }
    } catch {}
  }

  private handleCaptionsOptionChange(value: any): void {
    if (!value || !value.languageCode) {
      const offPayload: InjectedSubtitleOffPayload = {
        type: NCW_MESSAGE_TYPES.SUBTITLE_OFF,
        movieId: this.lastObservedVideoId,
        timestamp: Date.now(),
      };
      window.postMessage(offPayload, '*');
    } else {
      this.fetchAndEmitTrack(value);
    }
  }

  private tryEmitInitialActiveCaptions(): void {
    const player = this.getPlayerElement();
    if (!player || typeof player.getOption !== 'function') return;

    try {
      const track = player.getOption('captions', 'track');
      if (track && track.languageCode) {
        this.fetchAndEmitTrack(track);
      }
    } catch {}
  }

  private async fetchAndEmitTrack(track: any): Promise<void> {
    if (!track || !track.languageCode) return;

    const videoId = this.lastObservedVideoId || this.extractVideoId() || '';
    const lang = track.languageCode;
    const isAsr = track.kind === 'asr' || (track.vssId && track.vssId.startsWith('a.'));

    // Check if we can find direct baseUrl from captionTracks
    const captionTracks = this.getAvailableCaptionTracks();
    const matching = captionTracks.find(
      (t: any) =>
        t.languageCode === lang ||
        (t.vssId && track.vssId && t.vssId === track.vssId)
    );

    let fetchUrl = matching?.baseUrl;
    if (!fetchUrl && videoId) {
      fetchUrl = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}&fmt=json3${isAsr ? '&kind=asr' : ''}`;
    }

    if (!fetchUrl) return;

    // Ensure format is json3 if not specified
    if (!fetchUrl.includes('fmt=')) {
      fetchUrl += '&fmt=json3';
    }

    try {
      const res = await fetch(fetchUrl);
      if (res.ok) {
        const text = await res.text();
        if (text && text.length > 0) {
          this.handleInterceptedSubtitle(fetchUrl, text);
        }
      }
    } catch (err) {
      this.logger.warn('YouTube-AI-Sub', 'Failed fetching caption track directly:', err);
    }
  }

  // --- Content Script Message Communication ---
  private setupMessageListener(): void {
    this.messageListener = (event: MessageEvent) => {
      if (event.source !== window || !event.data) return;

      const type = event.data.type;
      if (type === NCW_MESSAGE_TYPES.REQUEST_SUBTITLE_RETRY) {
        this.handleRetryRequest();
      } else if (type === NCW_MESSAGE_TYPES.QUERY_NATIVE_TRACK) {
        this.handleQueryNativeTrack(event.data.movieId, event.data.targetLangCode);
      } else if (type === NCW_MESSAGE_TYPES.REQUEST_METADATA) {
        this.emitMetadataForCurrentVideo();
      }
    };
    window.addEventListener('message', this.messageListener);
  }

  private handleRetryRequest(): void {
    this.logger.info('YouTube-AI-Sub', 'Received subtitle retry request from content script.');
    // 1. If we have a recently intercepted subtitle for current video, re-emit it
    const currentVideoId = this.lastObservedVideoId || this.extractVideoId();
    if (this.lastInterceptedSubtitle && this.lastInterceptedSubtitle.videoId === currentVideoId) {
      const payload: InjectedSubtitleRawDataPayload = {
        type: NCW_MESSAGE_TYPES.SUBTITLE_RAW_DATA,
        movieId: this.lastInterceptedSubtitle.videoId,
        url: this.lastInterceptedSubtitle.url,
        pageUrl: window.location.href,
        rawText: this.lastInterceptedSubtitle.text,
        bcp47: this.lastInterceptedSubtitle.lang,
        timestamp: Date.now(),
        isReplay: true,
        isAsr: this.lastInterceptedSubtitle.isAsr,
      };
      window.postMessage(payload, '*');
      return;
    }

    // 2. Otherwise actively fetch from current track or first available caption track
    const tracks = this.getAvailableCaptionTracks();
    if (tracks.length > 0) {
      const player = this.getPlayerElement();
      const current = typeof player?.getOption === 'function' ? player.getOption('captions', 'track') : null;
      const targetTrack = current && current.languageCode
        ? tracks.find((t: any) => t.languageCode === current.languageCode) || tracks[0]
        : tracks[0];

      if (targetTrack && targetTrack.baseUrl) {
        this.fetchAndEmitTrack(targetTrack);
      }
    }
  }

  private async handleQueryNativeTrack(movieId: string, targetLangCode: string): Promise<void> {
    const tracks = this.getAvailableCaptionTracks();
    const normalizedTarget = targetLangCode.toLowerCase().split('-')[0];

    const match = tracks.find((t: any) => {
      const code = (t.languageCode || '').toLowerCase();
      return code === targetLangCode.toLowerCase() || code.startsWith(normalizedTarget);
    });

    if (match && match.baseUrl) {
      try {
        let fetchUrl = match.baseUrl;
        if (!fetchUrl.includes('fmt=')) fetchUrl += '&fmt=json3';

        const res = await fetch(fetchUrl);
        if (res.ok) {
          const text = await res.text();
          const responsePayload: InjectedNativeTrackDataPayload = {
            type: NCW_MESSAGE_TYPES.NATIVE_TRACK_DATA,
            movieId,
            found: true,
            bcp47: match.languageCode,
            rawText: text,
            targetLangCode,
          };
          window.postMessage(responsePayload, '*');
          return;
        }
      } catch {}
    }

    const notFoundPayload: InjectedNativeTrackDataPayload = {
      type: NCW_MESSAGE_TYPES.NATIVE_TRACK_DATA,
      movieId,
      found: false,
      targetLangCode,
    };
    window.postMessage(notFoundPayload, '*');
  }

  private getAvailableCaptionTracks(): any[] {
    // 1. Try window.ytInitialPlayerResponse
    const playerResponseTracks =
      window.ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (Array.isArray(playerResponseTracks) && playerResponseTracks.length > 0) {
      return playerResponseTracks;
    }

    // 2. Try movie_player getOption tracklist
    const player = this.getPlayerElement();
    if (player && typeof player.getOption === 'function') {
      try {
        const list = player.getOption('captions', 'tracklist');
        if (Array.isArray(list) && list.length > 0) {
          return list;
        }
      } catch {}
    }

    return [];
  }

  private getPlayerElement(): any {
    return document.getElementById('movie_player') || window.ytplayer;
  }

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
}
