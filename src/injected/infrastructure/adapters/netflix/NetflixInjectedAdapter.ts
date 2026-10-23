import {
  IInjectedAdapter,
  InjectedIncomingEvent,
} from '../../../domain/IInjectedAdapter';
import { VideoMetadata } from '../../../../content/domain/adapters/IStreamingAdapter';
import { STREAMING_PLATFORMS } from '@shared/domain/constants/StreamingPlatforms';
import { NCW_MESSAGE_TYPES } from '@shared/domain/constants/MessageTypes';
import { NetworkHook } from '../../network/NetworkHook';
import { NetflixPlayerBridge } from './NetflixPlayerBridge';
import { NetflixMetadataManager } from './NetflixMetadataManager';
import { NetflixTrackRegistry } from './NetflixTrackRegistry';
import { NetflixTimedTextTrack } from './NetflixTypes';
import { Logger } from '@shared/utils/logger';

export class NetflixInjectedAdapter implements IInjectedAdapter {
  readonly platformId = STREAMING_PLATFORMS.NETFLIX;

  private readonly logger = new Logger('NetflixInjectedAdapter');
  private readonly playerBridge: NetflixPlayerBridge;
  private readonly metadataManager: NetflixMetadataManager;
  private readonly trackRegistry: NetflixTrackRegistry;

  private currentEpisodeId: string | null = null;
  private lastReportedUrl = window.location.href;
  private lastEmittedSignature = '';
  private unhookNetwork?: () => void;
  private unhookMetadata?: () => void;

  constructor() {
    this.metadataManager = new NetflixMetadataManager();
    this.playerBridge = new NetflixPlayerBridge({
      onAdStateChange: this.handleAdStateChange,
      onEpisodeChange: this.handleEpisodeChange,
      onTimeSync: this.handleTimeSync,
      onSubtitleTrackChange: this.handleSubtitleTrackChange,
    });
    this.trackRegistry = new NetflixTrackRegistry(
      this.playerBridge,
      this.metadataManager,
    );
  }

  matches(url: string): boolean {
    return /netflix\.com/i.test(url);
  }

  initialize(): void {
    this.logger.info('Netflix', 'Initializing NetflixInjectedAdapter.');
    this.setupRouteMonitoring();
    this.setupNetworkInterceptor();
    this.setupMetadataInterceptor();
    this.setupMessageListener();
    this.playerBridge.start();

    const initialEpId = this.extractEpisodeId(window.location.href);
    if (initialEpId) {
      this.currentEpisodeId = initialEpId;
      this.playerBridge.setExpectedMovieId(initialEpId);
      this.handleEpisodeSelected(initialEpId);
    }
  }

  destroy(): void {
    this.unhookNetwork?.();
    this.unhookMetadata?.();
    this.playerBridge.stop();
  }

  // --------------------------------------------------------------------------
  // 1. SPA Navigation & Route Observer
  // --------------------------------------------------------------------------

  private setupRouteMonitoring(): void {
    const notifyUrlChange = () => {
      const current = window.location.href;
      if (current !== this.lastReportedUrl) {
        this.lastReportedUrl = current;
        this.lastEmittedSignature = '';
        window.postMessage({ type: NCW_MESSAGE_TYPES.URL_CHANGED, url: current }, '*');

        const currentEpId = this.extractEpisodeId(current);
        if (currentEpId) {
          this.currentEpisodeId = currentEpId;
          this.playerBridge.setExpectedMovieId(currentEpId);
          this.handleEpisodeSelected(currentEpId);
        }
      }
    };

    this.wrapHistoryMethods(notifyUrlChange);
    window.addEventListener('popstate', notifyUrlChange);
    if (window.navigation) {
      window.navigation.addEventListener('navigate', () => {
        setTimeout(notifyUrlChange, 0);
      });
    }
  }

  private wrapHistoryMethods(callback: () => void): void {
    const origPush = history.pushState;
    history.pushState = function (...args) {
      const res = origPush.apply(this, args);
      callback();
      return res;
    };

    const origReplace = history.replaceState;
    history.replaceState = function (...args) {
      const res = origReplace.apply(this, args);
      callback();
      return res;
    };
  }

  // --------------------------------------------------------------------------
  // 2. Network & Subtitle Interception
  // --------------------------------------------------------------------------

  private setupNetworkInterceptor(): void {
    this.unhookNetwork = NetworkHook.onSubtitlePayload((url, text) => {
      this.handleInterceptedSubtitle(url, text);
    });
  }

  private handleInterceptedSubtitle(url: string, text: string): void {
    if (!text || text.length < 50) return;

    const known = this.trackRegistry.addInterceptedTrack(url, text);
    if (!known) return;

    const currentEpisodeId = this.playerBridge.getCurrentMovieId();
    if (known.episodeId !== currentEpisodeId) return;

    const activeTrack = this.playerBridge.getActiveTextTrack(currentEpisodeId);
    if (!activeTrack || activeTrack.isNoneTrack || !activeTrack.bcp47) return;

    if (activeTrack.bcp47.toLowerCase() === known.lang) {
      this.emitSubtitleData(known.rawText, currentEpisodeId, known.lang, url);
    }
  }

  private emitSubtitleData(
    text: string,
    episodeId: string,
    bcp47: string,
    url: string | null,
  ): void {
    const signature = `${episodeId}_${text.length}_${text.slice(0, 80)}`;
    if (signature === this.lastEmittedSignature) return;

    this.lastEmittedSignature = signature;
    window.postMessage(
      {
        type: NCW_MESSAGE_TYPES.SUBTITLE_RAW_DATA,
        rawText: text,
        movieId: episodeId,
        bcp47,
        url,
        timestamp: Date.now(),
      },
      '*',
    );
    this.logger.info('Netflix', `Emitted subtitle data for movie ${episodeId} (${bcp47}).`);
  }

  // --------------------------------------------------------------------------
  // 3. Metadata Interception & Lifecycle
  // --------------------------------------------------------------------------

  private setupMetadataInterceptor(): void {
    this.unhookMetadata = NetworkHook.onMetadataPayload((_url, data) => {
      this.metadataManager.handleMetadataApiResponse(data);
      const currentEpId =
        this.currentEpisodeId ||
        this.playerBridge.getCurrentMovieId() ||
        this.extractEpisodeId(window.location.href);
      if (currentEpId) {
        this.handleEpisodeSelected(currentEpId);
      }
    });
  }

  private async handleEpisodeSelected(episodeId: string): Promise<void> {
    if (!this.metadataManager.isEpisodeCached(episodeId)) {
      await this.metadataManager.fetchMetadata(episodeId);
    }
    const payload = this.metadataManager.buildMetadataPayload(episodeId);
    if (!payload) return;

    this.metadataManager.syncToDomDataset(payload);
    window.postMessage(payload, '*');
    this.logger.info('Netflix', `Emitted metadata for show ${payload.showId}.`);
  }

  // --------------------------------------------------------------------------
  // 4. Player Bridge Event Callbacks
  // --------------------------------------------------------------------------

  private handleEpisodeChange = async (
    movieId: string,
    sessionId: string,
    url: string,
  ): Promise<void> => {
    this.lastEmittedSignature = '';
    this.currentEpisodeId = movieId;
    this.playerBridge.setExpectedMovieId(movieId);
    window.postMessage(
      { type: NCW_MESSAGE_TYPES.EPISODE_CHANGED, movieId, sessionId, url },
      '*',
    );

    const showId = this.metadataManager.getShowId(movieId);
    this.trackRegistry.checkUnknownTracks(showId, movieId);
    await this.handleEpisodeSelected(movieId);
    await this.activatePreloadedTrackIfAvailable(showId, movieId);
  };

  private async activatePreloadedTrackIfAvailable(
    showId: string,
    movieId: string,
  ): Promise<void> {
    const activeTrack = this.playerBridge.getActiveTextTrack(movieId);
    if (!activeTrack || activeTrack.isNoneTrack || !activeTrack.bcp47) return;

    const track = await this.trackRegistry.getTrack(
      showId,
      movieId,
      activeTrack.bcp47,
    );
    if (track) {
      this.logger.info('Netflix', `⚡ Instantly activating preloaded track (${track.lang}).`);
      this.emitSubtitleData(track.rawText, movieId, track.lang, track.urls[0] || null);
    }
  }

  private handleSubtitleTrackChange = async (
    track: NetflixTimedTextTrack,
    isOff: boolean,
  ): Promise<void> => {
    const currentEpId = this.currentEpisodeId || this.playerBridge.getCurrentMovieId();
    if (!currentEpId) return;

    if (isOff || !track.bcp47) {
      window.postMessage(
        { type: NCW_MESSAGE_TYPES.SUBTITLE_OFF, movieId: currentEpId, timestamp: Date.now() },
        '*',
      );
      return;
    }

    const showId = this.metadataManager.getShowId(currentEpId);
    const detail = await this.trackRegistry.getTrack(showId, currentEpId, track.bcp47);
    if (detail) {
      this.emitSubtitleData(detail.rawText, currentEpId, detail.lang, detail.urls[0] || null);
    }
  };

  private handleTimeSync = (payload: {
    segmentTime: number;
    syncAt: number;
    isPaused: boolean;
    playbackRate: number;
  }): void => {
    window.postMessage({ type: NCW_MESSAGE_TYPES.TIME_SYNC, ...payload }, '*');
  };

  private handleAdStateChange = (isAd: boolean): void => {
    window.postMessage({ type: NCW_MESSAGE_TYPES.AD_STATE_CHANGED, isAd }, '*');
  };

  // --------------------------------------------------------------------------
  // 5. Message Listener (ISOLATED World -> MAIN World)
  // --------------------------------------------------------------------------

  private setupMessageListener(): void {
    window.addEventListener('message', async (event) => {
      if (event.source !== window || !event.data) return;
      const data: InjectedIncomingEvent = event.data;

      if (data.type === NCW_MESSAGE_TYPES.REQUEST_SUBTITLE_RETRY) {
        await this.handleRetryRequest();
      }

      if (data.type === NCW_MESSAGE_TYPES.QUERY_NATIVE_TRACK) {
        await this.handleQueryNativeTrack(data.movieId, data.targetLangCode);
      }

      if ((data as any).type === NCW_MESSAGE_TYPES.REQUEST_METADATA) {
        const requestedMid = (data as any).movieId ? String((data as any).movieId) : null;
        const targetEpId =
          requestedMid ||
          this.currentEpisodeId ||
          this.playerBridge.getCurrentMovieId() ||
          this.extractEpisodeId(window.location.href);
        if (targetEpId) {
          await this.handleEpisodeSelected(targetEpId);
        }
      }

      if ((data as any).type === NCW_MESSAGE_TYPES.QUERY_METADATA) {
        const queryId = (data as any).queryId;
        const requestedMid = (data as any).movieId ? String((data as any).movieId) : null;
        const expectedMid = requestedMid || this.currentEpisodeId;

        const respond = (status: 'resolved' | 'null' | 'undefined', metadata?: VideoMetadata) => {
          window.postMessage(
            {
              type: NCW_MESSAGE_TYPES.QUERY_METADATA_RESULT,
              queryId,
              status,
              metadata,
            },
            '*'
          );
        };

        // Strictly validate that the player for the expected movie ID is loaded
        const player = this.playerBridge.getActivePlayer(expectedMid || undefined);
        if (!player) {
          this.logger.warn(
            'Netflix',
            `QUERY_METADATA player not loaded yet for expected movie: ${expectedMid}. Responding undefined.`
          );
          respond('undefined');
          return;
        }

        const playerMovieId = String(player.getMovieId());
        if (expectedMid && playerMovieId !== expectedMid) {
          this.logger.warn(
            'Netflix',
            `QUERY_METADATA mismatch: expected=${expectedMid}, player=${playerMovieId}. Responding undefined.`
          );
          respond('undefined');
          return;
        }

        const targetMid = playerMovieId;
        const payload = this.metadataManager.buildMetadataPayload(targetMid);
        if (payload) {
          const meta: VideoMetadata = {
            mainTitle: payload.showTitle,
            episodeTitle: payload.currentEpisode?.episodeTitle || '',
            fullTitle: payload.currentEpisode?.episodeTitle
              ? `${payload.showTitle} - ${payload.currentEpisode.episodeTitle}`
              : payload.showTitle,
            videoId: payload.currentEpisode?.episodeId || targetMid,
            showId: payload.showId,
            seasonId: payload.seasonId,
            showSummary: payload.showSynopsis,
            episodeSummary: payload.currentEpisode?.episodeSynopsis,
            seasonNum: payload.seasonSeq,
            episodeNum: payload.currentEpisode?.episodeSeq,
          };
          respond('resolved', meta);
        } else {
          // If not cached yet, proactively fetch and reply undefined (pending)
          this.metadataManager.fetchMetadata(targetMid).then((video) => {
            if (video) {
              const freshPayload = this.metadataManager.buildMetadataPayload(targetMid);
              if (freshPayload) {
                window.postMessage(freshPayload, '*');
              }
            }
          });
          respond('undefined');
        }
      }
    });
  }

  private async handleRetryRequest(): Promise<void> {
    const currentEpId = this.currentEpisodeId || this.playerBridge.getCurrentMovieId();
    if (!currentEpId) return;
    const activeTrack = this.playerBridge.getActiveTextTrack(currentEpId);
    if (!activeTrack || activeTrack.isNoneTrack || !activeTrack.bcp47) return;

    this.lastEmittedSignature = '';
    const showId = this.metadataManager.getShowId(currentEpId);
    const track = await this.trackRegistry.getTrack(showId, currentEpId, activeTrack.bcp47);
    if (track) {
      this.emitSubtitleData(track.rawText, currentEpId, track.lang, track.urls[0] || null);
    }
  }

  private async handleQueryNativeTrack(
    movieId: string,
    targetLangCode: string,
  ): Promise<void> {
    const showId = this.metadataManager.getShowId(movieId);
    const trackResult = await this.trackRegistry.getTrack(showId, movieId, targetLangCode);

    let status: 'found' | 'not_found' | 'not_ready';
    if (trackResult === undefined) {
      status = 'not_ready';
    } else if (trackResult === null) {
      status = 'not_found';
    } else {
      status = 'found';
    }

    window.postMessage(
      {
        type: NCW_MESSAGE_TYPES.NATIVE_TRACK_DATA,
        movieId,
        targetLangCode,
        status,
        found: status === 'found',
        bcp47: trackResult ? trackResult.lang : undefined,
        rawText: trackResult ? trackResult.rawText : undefined,
      },
      '*',
    );
  }

  private extractEpisodeId(url: string): string | null {
    const match = url.match(/\/watch\/(\d+)/);
    return match ? match[1] : null;
  }
}
