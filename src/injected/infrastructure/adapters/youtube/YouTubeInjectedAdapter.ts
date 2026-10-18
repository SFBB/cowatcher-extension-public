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

export interface YouTubeTrackItem {
  languageCode: string;
  name?: string;
  vssId?: string;
  kind?: string;
  isAsr?: boolean;
  baseUrl?: string;
  isDefault?: boolean;
}

export interface YouTubeCachedSubtitle {
  trackKey: string;
  videoId: string;
  languageCode: string;
  isAsr: boolean;
  rawText: string;
  url: string;
  timestamp: number;
}

export interface YouTubeVideoTrackRecord {
  videoId: string;
  tracks: YouTubeTrackItem[];
  cachedSubtitles: Map<string, YouTubeCachedSubtitle>;
  activeTrackKey: string | null;
  targetLangCode?: string;
  nativeTrackCached?: boolean;
  lastEmittedSignature?: string;
  userExplicitlyDisabledCaptions?: boolean;
  isFetchingActiveTrack?: boolean;
  isFetchingNativeTrack?: boolean;
}

export class YouTubeInjectedAdapter implements IInjectedAdapter {
  readonly platformId: StreamingPlatformId = STREAMING_PLATFORMS.YOUTUBE;
  private readonly logger: Logger = new Logger('YouTubeInjectedAdapter');

  /**
   * Track records store keyed by YouTube videoId.
   * Maintains track lists, cached subtitle raw payloads, active track states, and native target tracks.
   */
  private videoRecords: Map<string, YouTubeVideoTrackRecord> = new Map();

  private lastReportedUrl: string = '';
  private lastObservedVideoId: string | null = null;
  private lastAdState: boolean = false;
  private pollIntervalId: NodeJS.Timeout | number | null = null;
  private messageListener: ((e: MessageEvent) => void) | null = null;
  private unhookNetwork?: () => void;

  matches(url: string): boolean {
    return /youtube\.com/i.test(url);
  }

  initialize(): void {
    if (window.__NCW_YOUTUBE_INTERCEPTOR_INITIALIZED__) return;
    window.__NCW_YOUTUBE_INTERCEPTOR_INITIALIZED__ = true;

    this.lastReportedUrl = window.location.href;
    this.lastObservedVideoId = this.extractVideoId(window.location.href);

    this.logger.info('YouTube-AI-Sub', 'Initializing YouTube Injected Adapter with Video Track Store.');

    this.setupNetworkInterceptor();
    this.setupNavigationMonitoring();
    this.setupPlayerBridge();
    this.setupMessageListener();

    // Start background polling for route, ad, and captions state
    this.pollIntervalId = setInterval(() => {
      this.checkUrlAndVideoChange();
      this.checkPlayerAdState();
      this.checkPlayerCaptionsState();
    }, 500);

    // Initial warmup
    setTimeout(() => {
      this.emitMetadataForCurrentVideo();
      this.checkPlayerCaptionsState();
    }, 600);
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

  // --- Track Info Store Management ---
  private getVideoRecord(videoId: string): YouTubeVideoTrackRecord {
    let record = this.videoRecords.get(videoId);
    if (!record) {
      record = {
        videoId,
        tracks: [],
        cachedSubtitles: new Map(),
        activeTrackKey: null,
        targetLangCode: undefined,
        nativeTrackCached: false,
        lastEmittedSignature: undefined,
        userExplicitlyDisabledCaptions: false,
        isFetchingActiveTrack: false,
        isFetchingNativeTrack: false,
      };
      this.videoRecords.set(videoId, record);
    }
    return record;
  }

  private getCurrentVideoId(): string | null {
    return this.lastObservedVideoId || this.extractVideoId(window.location.href);
  }

  // --- Network Interception & Subtitle Caching ---
  private setupNetworkInterceptor(): void {
    this.unhookNetwork = NetworkHook.onSubtitlePayload((url, text) => {
      if (!url.toLowerCase().includes('timedtext')) return;
      this.handleInterceptedSubtitle(url, text);
    });
  }

  private handleInterceptedSubtitle(url: string, text: string): void {
    try {
      const urlObj = new URL(url, window.location.origin);
      const videoId = urlObj.searchParams.get('v') || this.getCurrentVideoId() || '';
      if (!videoId) return;

      const lang = urlObj.searchParams.get('lang') || 'en';
      const kind = urlObj.searchParams.get('kind');
      const isAsr = kind === 'asr' || url.includes('kind=asr');
      const trackKey = `${lang}_${isAsr ? 'asr' : 'normal'}`;

      const record = this.getVideoRecord(videoId);

      const cachedItem: YouTubeCachedSubtitle = {
        trackKey,
        videoId,
        languageCode: lang,
        isAsr,
        rawText: text,
        url,
        timestamp: Date.now(),
      };

      // Cache by full trackKey as well as lang shorthand
      record.cachedSubtitles.set(trackKey, cachedItem);
      record.cachedSubtitles.set(lang, cachedItem);
      record.isFetchingActiveTrack = false;

      // Check if this fulfills a native target track requirement
      if (record.targetLangCode) {
        const targetNormalized = record.targetLangCode.toLowerCase().split('-')[0];
        if (
          lang.toLowerCase() === record.targetLangCode.toLowerCase() ||
          lang.toLowerCase().startsWith(targetNormalized)
        ) {
          record.nativeTrackCached = true;
          record.isFetchingNativeTrack = false;
        }
      }

      this.logger.info(
        'YouTube-AI-Sub',
        `Cached timedtext in track info store [video: ${videoId}, trackKey: ${trackKey}, bytes: ${text.length}]`
      );

      // If this intercepted subtitle is for the current playing video, emit to content script
      const currentVideoId = this.getCurrentVideoId();
      if (videoId === currentVideoId) {
        const signature = `${videoId}_${trackKey}_${text.length}`;
        if (signature !== record.lastEmittedSignature) {
          record.lastEmittedSignature = signature;
          record.activeTrackKey = trackKey;
          record.userExplicitlyDisabledCaptions = false;

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
        }
      }
    } catch (err) {
      this.logger.error('YouTube-AI-Sub', 'Error handling intercepted subtitle:', err);
    }
  }

  // --- Navigation & Route Monitoring ---
  private setupNavigationMonitoring(): void {
    const onNavigate = () => {
      this.checkUrlAndVideoChange();
      setTimeout(() => {
        this.emitMetadataForCurrentVideo();
        this.checkPlayerCaptionsState();
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

      const epPayload: InjectedEpisodeChangedPayload = {
        type: NCW_MESSAGE_TYPES.EPISODE_CHANGED,
        movieId: currentVideoId,
        url: currentUrl,
      };
      window.postMessage(epPayload, '*');
      this.emitMetadataForCurrentVideo();

      // Check if we already have cached subtitles for this video from previous view
      const record = this.getVideoRecord(currentVideoId);
      if (record.cachedSubtitles.size > 0 && record.activeTrackKey) {
        const cached =
          record.cachedSubtitles.get(record.activeTrackKey) ||
          record.cachedSubtitles.values().next().value;
        if (cached) {
          this.logger.info(
            'YouTube-AI-Sub',
            `Replaying cached subtitle for returning video ${currentVideoId}`
          );
          this.emitCachedSubtitle(cached, true);
        }
      }
    }
  }

  // --- Metadata Extraction ---
  private emitMetadataForCurrentVideo(): void {
    const videoId = this.getCurrentVideoId();
    if (!videoId) return;

    let title = '';
    let description = '';

    const player = this.getPlayerElement();
    if (player && typeof player.getVideoData === 'function') {
      try {
        const data = player.getVideoData();
        if (data && data.title) title = data.title;
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

  // --- Subtitle Polling & Robust State Management ---
  private checkPlayerCaptionsState(): void {
    const player = this.getPlayerElement();
    const currentVideoId = this.getCurrentVideoId();
    if (!player || !currentVideoId) return;

    try {
      // 1. Guard against video desynchronization during route transitions
      if (typeof player.getVideoData === 'function') {
        const playerVideoId = player.getVideoData()?.video_id;
        if (playerVideoId && playerVideoId !== currentVideoId) {
          // Player is still unloading previous video or loading new video, hold state
          return;
        }
      }

      const record = this.getVideoRecord(currentVideoId);

      // 2. Refresh available tracks in record
      this.refreshVideoTracks(currentVideoId, record);

      // 3. Proactively cache native target language track if requested and available
      this.checkAndCacheNativeTargetTrack(currentVideoId, record);

      // 4. Poll current caption track selection from player
      if (typeof player.getOption !== 'function') return;
      const track = player.getOption('captions', 'track');
      const hasActiveTrack = Boolean(track && track.languageCode);

      if (hasActiveTrack) {
        const lang = track.languageCode;
        const isAsr = track.kind === 'asr' || (track.vssId && track.vssId.startsWith('a.'));
        const trackKey = `${lang}_${isAsr ? 'asr' : 'normal'}`;

        record.activeTrackKey = trackKey;
        record.userExplicitlyDisabledCaptions = false;

        // Check cache for this track
        const cached = record.cachedSubtitles.get(trackKey) || record.cachedSubtitles.get(lang);
        if (cached) {
          const sig = `${currentVideoId}_${trackKey}_${cached.rawText.length}`;
          if (sig !== record.lastEmittedSignature) {
            record.lastEmittedSignature = sig;
            this.logger.info(
              'YouTube-AI-Sub',
              `Instant cache hit for active track [${trackKey}], emitting to content script.`
            );
            this.emitCachedSubtitle(cached, false);
          }
        } else {
          // Cache miss: actively fetch and cache
          if (!record.isFetchingActiveTrack) {
            this.fetchAndCacheTrack(currentVideoId, record, track);
          }
        }
      } else {
        // Captions are off in the player
        // Eliminate false SUBTITLE_OFF: Only emit if captions were genuinely active before
        // AND player is currently in active playback/paused state (not unstarted / buffering initial video load)
        const playerState = typeof player.getPlayerState === 'function' ? player.getPlayerState() : -1;
        const isPlayingOrPaused = playerState === 1 || playerState === 2;

        if (
          isPlayingOrPaused &&
          record.activeTrackKey !== null &&
          !record.userExplicitlyDisabledCaptions
        ) {
          record.userExplicitlyDisabledCaptions = true;
          record.activeTrackKey = null;
          record.lastEmittedSignature = undefined;

          this.logger.info('YouTube-AI-Sub', `Captions explicitly disabled by user for ${currentVideoId}`);
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

  private handleCaptionsOptionChange(value: any): void {
    const currentVideoId = this.getCurrentVideoId();
    if (!currentVideoId) return;

    const record = this.getVideoRecord(currentVideoId);

    if (!value || !value.languageCode) {
      if (record.activeTrackKey !== null && !record.userExplicitlyDisabledCaptions) {
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
      const isAsr = value.kind === 'asr' || (value.vssId && value.vssId.startsWith('a.'));
      const trackKey = `${lang}_${isAsr ? 'asr' : 'normal'}`;

      record.activeTrackKey = trackKey;
      record.userExplicitlyDisabledCaptions = false;

      const cached = record.cachedSubtitles.get(trackKey) || record.cachedSubtitles.get(lang);
      if (cached) {
        this.emitCachedSubtitle(cached, false);
      } else {
        this.fetchAndCacheTrack(currentVideoId, record, value);
      }
    }
  }

  private emitCachedSubtitle(cached: YouTubeCachedSubtitle, isReplay: boolean = false): void {
    const record = this.getVideoRecord(cached.videoId);
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

  private async fetchAndCacheTrack(
    videoId: string,
    record: YouTubeVideoTrackRecord,
    track: any
  ): Promise<void> {
    if (!track || !track.languageCode) return;

    record.isFetchingActiveTrack = true;
    const lang = track.languageCode;
    const isAsr = track.kind === 'asr' || (track.vssId && track.vssId.startsWith('a.'));

    // Check available caption tracks for direct baseUrl
    const matching = record.tracks.find(
      (t) =>
        t.languageCode === lang ||
        (t.vssId && track.vssId && t.vssId === track.vssId)
    );

    let fetchUrl = matching?.baseUrl;
    if (fetchUrl) {
      try {
        const parsed = new URL(fetchUrl, window.location.origin);
        const urlV = parsed.searchParams.get('v');
        if (urlV && urlV !== videoId) {
          fetchUrl = undefined;
        }
      } catch {
        fetchUrl = undefined;
      }
    }

    if (!fetchUrl && videoId) {
      fetchUrl = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}&fmt=json3${isAsr ? '&kind=asr' : ''}`;
    }

    if (!fetchUrl) {
      record.isFetchingActiveTrack = false;
      return;
    }

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
      this.logger.warn('YouTube-AI-Sub', 'Direct fetch for track failed:', err);
    } finally {
      record.isFetchingActiveTrack = false;
    }
  }

  // --- Track Discovery & Native Target Language Caching ---
  private refreshVideoTracks(videoId: string, record: YouTubeVideoTrackRecord): void {
    const player = this.getPlayerElement();
    const tracks: YouTubeTrackItem[] = [];

    // 1. Try movie_player getPlayerResponse()
    if (player && typeof player.getPlayerResponse === 'function') {
      try {
        const pr = player.getPlayerResponse();
        const prVideoId = pr?.videoDetails?.videoId;
        if (!prVideoId || prVideoId === videoId) {
          const rawTracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
          if (Array.isArray(rawTracks)) {
            rawTracks.forEach((t: any) => {
              if (t && t.languageCode) {
                tracks.push({
                  languageCode: t.languageCode,
                  name: t.name?.simpleText,
                  vssId: t.vssId,
                  kind: t.kind,
                  isAsr: t.kind === 'asr' || (t.vssId && t.vssId.startsWith('a.')),
                  baseUrl: t.baseUrl,
                  isDefault: Boolean(t.isDefault),
                });
              }
            });
          }
        }
      } catch {}
    }

    // 2. Try movie_player getOption tracklist
    if (tracks.length === 0 && player && typeof player.getOption === 'function') {
      try {
        const list = player.getOption('captions', 'tracklist');
        if (Array.isArray(list)) {
          list.forEach((t: any) => {
            if (t && t.languageCode) {
              tracks.push({
                languageCode: t.languageCode,
                name: t.name,
                vssId: t.vssId,
                kind: t.kind,
                isAsr: t.kind === 'asr' || (t.vssId && t.vssId.startsWith('a.')),
                baseUrl: t.baseUrl,
              });
            }
          });
        }
      } catch {}
    }

    // 3. Fallback to window.ytInitialPlayerResponse
    if (tracks.length === 0 && window.ytInitialPlayerResponse?.videoDetails?.videoId === videoId) {
      const initTracks =
        window.ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (Array.isArray(initTracks)) {
        initTracks.forEach((t: any) => {
          if (t && t.languageCode) {
            tracks.push({
              languageCode: t.languageCode,
              name: t.name?.simpleText,
              vssId: t.vssId,
              kind: t.kind,
              isAsr: t.kind === 'asr' || (t.vssId && t.vssId.startsWith('a.')),
              baseUrl: t.baseUrl,
              isDefault: Boolean(t.isDefault),
            });
          }
        });
      }
    }

    if (tracks.length > 0) {
      record.tracks = tracks;
    }
  }

  private async checkAndCacheNativeTargetTrack(
    videoId: string,
    record: YouTubeVideoTrackRecord
  ): Promise<void> {
    if (
      !record.targetLangCode ||
      record.nativeTrackCached ||
      record.tracks.length === 0 ||
      record.isFetchingNativeTrack
    ) {
      return;
    }

    const targetCode = record.targetLangCode.toLowerCase();
    const targetPrefix = targetCode.split('-')[0];

    // Look for matching non-ASR human-authored track first, then fallback to any matching track
    const match =
      record.tracks.find((t) => {
        const c = (t.languageCode || '').toLowerCase();
        return !t.isAsr && (c === targetCode || c.startsWith(targetPrefix));
      }) ||
      record.tracks.find((t) => {
        const c = (t.languageCode || '').toLowerCase();
        return c === targetCode || c.startsWith(targetPrefix);
      });

    if (!match) return;

    record.isFetchingNativeTrack = true;
    this.logger.info(
      'YouTube-AI-Sub',
      `Detected available native target track (${match.languageCode}) for ${videoId}. Proactively caching...`
    );

    // Strategy A: Fetch direct baseUrl
    if (match.baseUrl) {
      try {
        let fetchUrl = match.baseUrl;
        if (!fetchUrl.includes('fmt=')) fetchUrl += '&fmt=json3';

        const res = await fetch(fetchUrl);
        if (res.ok) {
          const text = await res.text();
          if (text && text.length > 0) {
            this.handleInterceptedSubtitle(fetchUrl, text);
            record.nativeTrackCached = true;
            record.isFetchingNativeTrack = false;
            return;
          }
        }
      } catch (e) {
        this.logger.debug('YouTube-AI-Sub', 'Direct baseUrl fetch failed, trying setOption:', e);
      }
    }

    // Strategy B: Trigger native player track switch to force YouTube timedtext fetch & interception
    this.triggerPlayerTrackSwitch(match.languageCode, record);
  }

  private triggerPlayerTrackSwitch(
    targetLanguageCode: string,
    record: YouTubeVideoTrackRecord
  ): void {
    const player = this.getPlayerElement();
    if (!player || typeof player.setOption !== 'function' || typeof player.getOption !== 'function') {
      record.isFetchingNativeTrack = false;
      return;
    }

    try {
      const originalTrack = player.getOption('captions', 'track');
      player.setOption('captions', 'track', { languageCode: targetLanguageCode });

      // After triggering network request, restore original user track after short tick
      setTimeout(() => {
        if (!originalTrack || !originalTrack.languageCode) {
          player.setOption('captions', 'track', {});
        } else if (originalTrack.languageCode !== targetLanguageCode) {
          player.setOption('captions', 'track', originalTrack);
        }
        record.isFetchingNativeTrack = false;
      }, 400);
    } catch {
      record.isFetchingNativeTrack = false;
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
    const currentVideoId = this.getCurrentVideoId();
    if (!currentVideoId) return;

    this.logger.info('YouTube-AI-Sub', `Handling subtitle retry request for ${currentVideoId}`);
    const record = this.getVideoRecord(currentVideoId);

    // 1. If we have any cached subtitle for this video, re-emit immediately
    if (record.cachedSubtitles.size > 0) {
      const targetCached =
        (record.activeTrackKey && record.cachedSubtitles.get(record.activeTrackKey)) ||
        record.cachedSubtitles.values().next().value;
      if (targetCached) {
        this.emitCachedSubtitle(targetCached, true);
        return;
      }
    }

    // 2. Otherwise actively fetch from current track or first available caption track
    this.refreshVideoTracks(currentVideoId, record);
    if (record.tracks.length > 0) {
      const player = this.getPlayerElement();
      const current = typeof player?.getOption === 'function' ? player.getOption('captions', 'track') : null;
      const targetTrack =
        (current && current.languageCode && record.tracks.find((t) => t.languageCode === current.languageCode)) ||
        record.tracks[0];

      if (targetTrack) {
        this.fetchAndCacheTrack(currentVideoId, record, targetTrack);
      }
    }
  }

  private async handleQueryNativeTrack(movieId: string, targetLangCode: string): Promise<void> {
    const effectiveVideoId = movieId || this.getCurrentVideoId() || '';
    if (!effectiveVideoId || !targetLangCode) {
      this.sendNativeTrackNotFound(effectiveVideoId, targetLangCode);
      return;
    }

    const record = this.getVideoRecord(effectiveVideoId);
    record.targetLangCode = targetLangCode;

    // 1. Check if matching track is already cached in store
    const targetNormalized = targetLangCode.toLowerCase().split('-')[0];
    for (const [_, item] of record.cachedSubtitles.entries()) {
      const c = item.languageCode.toLowerCase();
      if (c === targetLangCode.toLowerCase() || c.startsWith(targetNormalized)) {
        this.sendNativeTrackFound(effectiveVideoId, item.languageCode, item.rawText, targetLangCode);
        return;
      }
    }

    // 2. Discover tracks and attempt direct fetch
    this.refreshVideoTracks(effectiveVideoId, record);
    const match =
      record.tracks.find((t) => {
        const c = (t.languageCode || '').toLowerCase();
        return !t.isAsr && (c === targetLangCode.toLowerCase() || c.startsWith(targetNormalized));
      }) ||
      record.tracks.find((t) => {
        const c = (t.languageCode || '').toLowerCase();
        return c === targetLangCode.toLowerCase() || c.startsWith(targetNormalized);
      });

    if (match && match.baseUrl) {
      try {
        let fetchUrl = match.baseUrl;
        if (!fetchUrl.includes('fmt=')) fetchUrl += '&fmt=json3';

        const res = await fetch(fetchUrl);
        if (res.ok) {
          const text = await res.text();
          if (text && text.length > 0) {
            this.handleInterceptedSubtitle(fetchUrl, text);
            this.sendNativeTrackFound(effectiveVideoId, match.languageCode, text, targetLangCode);
            return;
          }
        }
      } catch {}
    }

    // 3. Trigger native player caching if available
    if (match) {
      this.triggerPlayerTrackSwitch(match.languageCode, record);
    }

    this.sendNativeTrackNotFound(effectiveVideoId, targetLangCode);
  }

  private sendNativeTrackFound(
    movieId: string,
    bcp47: string,
    rawText: string,
    targetLangCode: string
  ): void {
    const payload: InjectedNativeTrackDataPayload = {
      type: NCW_MESSAGE_TYPES.NATIVE_TRACK_DATA,
      movieId,
      found: true,
      bcp47,
      rawText,
      targetLangCode,
    };
    window.postMessage(payload, '*');
  }

  private sendNativeTrackNotFound(movieId: string, targetLangCode: string): void {
    const notFoundPayload: InjectedNativeTrackDataPayload = {
      type: NCW_MESSAGE_TYPES.NATIVE_TRACK_DATA,
      movieId,
      found: false,
      targetLangCode,
    };
    window.postMessage(notFoundPayload, '*');
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
