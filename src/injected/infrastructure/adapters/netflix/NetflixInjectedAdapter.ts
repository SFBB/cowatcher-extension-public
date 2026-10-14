import { IInjectedAdapter, InjectedMetadataLoadedPayload } from '../../../domain/IInjectedAdapter';
import { STREAMING_PLATFORMS } from '@shared/domain/constants/StreamingPlatforms';
import { NCW_MESSAGE_TYPES } from '@shared/domain/constants/MessageTypes';
import { NetworkHook } from '../../network/NetworkHook';
import { KadmiumPlayerBridge } from './KadmiumPlayerBridge';
import { Logger } from '@shared/utils/logger';

interface PreloadItem {
  url: string | null;
  text: string;
  bcp47: string | null;
  timestamp: number;
}

interface InterceptedSubtitle {
  movieId: string | null;
  url: string | null;
  text: string;
  bcp47: string | null;
  timestamp: number;
}

export class NetflixInjectedAdapter implements IInjectedAdapter {
  readonly platformId = STREAMING_PLATFORMS.NETFLIX;

  private kadmiumBridge: KadmiumPlayerBridge | null = null;
  private preloadedSubtitlesByMovieId = new Map<string, PreloadItem>();
  private latestUnknownPreload: PreloadItem | null = null;
  private lastEmittedSignature = '';
  private lastInterceptedSubtitle: InterceptedSubtitle | null = null;
  private lastReportedUrl = window.location.href;
  private lastHandledMetadataMovieId: string | null = null;
  private cachedShowMetadata: any = null;
  private unhookNetwork?: () => void;
  private unhookMetadata?: () => void;
  private routeCheckInterval?: any;
  private isProbingNativeTrack = false;
  private probingTargetBcp: string | null = null;
  private probeSuppressTimer?: any;
  private activeNativeTrackProbe: ((url: string | null, text: string) => boolean) | null = null;

  private logger: Logger = new Logger('NetflixInjectedAdapter');

  matches(url: string): boolean {
    return /netflix\.com/i.test(url);
  }

  initialize(): void {
    this.logger.info('Netflix', 'NetflixInjectedAdapter initializing in page context.');

    this.setupRouteMonitoring();
    this.setupKadmiumBridge();
    this.setupNetworkInterceptor();
    this.setupMetadataInterceptor();
    this.setupMessageListener();

    // Initial check for metadata if page loaded directly on a watch URL
    const initialMid = this.extractVideoId(window.location.href);
    if (initialMid) {
      if (!this.emitMetadataForEpisode(initialMid)) {
        this.ensureMetadata(initialMid);
      }
    }
  }

  destroy(): void {
    this.unhookNetwork?.();
    this.unhookMetadata?.();
    this.kadmiumBridge?.stop();
    if (this.routeCheckInterval) {
      clearInterval(this.routeCheckInterval);
      this.routeCheckInterval = null;
    }
    if (this.probeSuppressTimer) {
      clearTimeout(this.probeSuppressTimer);
      this.probeSuppressTimer = null;
    }
  }

  private setupRouteMonitoring(): void {
    const notifyUrlChange = () => {
      const current = window.location.href;
      if (current !== this.lastReportedUrl) {
        this.lastReportedUrl = current;
        this.lastEmittedSignature = '';
        window.postMessage(
          {
            type: NCW_MESSAGE_TYPES.URL_CHANGED,
            url: current,
          },
          '*'
        );

        const currentMid = this.extractVideoId(current);
        if (currentMid) {
          if (!this.emitMetadataForEpisode(currentMid)) {
            this.clearStaleDatasetMetadata();
            this.cachedShowMetadata = null;
            this.ensureMetadata(currentMid);
          }
        }
      }
    };

    const origPushState = history.pushState;
    history.pushState = function (...args) {
      const res = origPushState.apply(this, args);
      notifyUrlChange();
      return res;
    };

    const origReplaceState = history.replaceState;
    history.replaceState = function (...args) {
      const res = origReplaceState.apply(this, args);
      notifyUrlChange();
      return res;
    };

    window.addEventListener('popstate', notifyUrlChange);
    this.routeCheckInterval = setInterval(notifyUrlChange, 1000);

    if (typeof window.navigation !== 'undefined' && window.navigation.addEventListener) {
      try {
        window.navigation.addEventListener('navigate', () => {
          setTimeout(notifyUrlChange, 0);
        });
      } catch {}
    }
  }

  private clearStaleDatasetMetadata(): void {
    if (document.documentElement && document.documentElement.dataset) {
      delete document.documentElement.dataset.ncwShowId;
      delete document.documentElement.dataset.ncwMainTitle;
      delete document.documentElement.dataset.ncwShowSummary;
      delete document.documentElement.dataset.ncwSeasonId;
      delete document.documentElement.dataset.ncwEpisodeTitle;
      delete document.documentElement.dataset.ncwEpisodeSummary;
    }
  }

  private setupKadmiumBridge(): void {
    this.kadmiumBridge = new KadmiumPlayerBridge({
      onAdStateChange: (isAd) => {
        window.postMessage({ type: NCW_MESSAGE_TYPES.AD_STATE_CHANGED, isAd }, '*');
      },
      onEpisodeChange: (movieId, sessionId, url) => {
        this.lastEmittedSignature = '';
        const midStr = String(movieId);
        window.postMessage(
          {
            type: NCW_MESSAGE_TYPES.EPISODE_CHANGED,
            movieId,
            sessionId,
            url,
          },
          '*'
        );

        if (!this.emitMetadataForEpisode(midStr)) {
          this.clearStaleDatasetMetadata();
          this.cachedShowMetadata = null;
          this.ensureMetadata(midStr);
        }

        if (this.preloadedSubtitlesByMovieId.has(midStr)) {
          const preloaded = this.preloadedSubtitlesByMovieId.get(midStr)!;
          this.preloadedSubtitlesByMovieId.delete(midStr);
          this.logger.info(
            'Netflix',
            `⚡ Instantly activating preloaded subtitle for new episode (${midStr}).`
          );
          this.emitSubtitleData(preloaded.url, preloaded.text, true, midStr, preloaded.bcp47);
        } else if (
          this.latestUnknownPreload &&
          Date.now() - this.latestUnknownPreload.timestamp < 300000
        ) {
          const preloaded = this.latestUnknownPreload;
          this.latestUnknownPreload = null;
          this.logger.info(
            'Netflix',
            `⚡ Instantly activating unknown preloaded subtitle for new episode (${midStr}).`
          );
          this.emitSubtitleData(preloaded.url, preloaded.text, true, midStr, preloaded.bcp47);
        } else {
          setTimeout(() => {
            this.kadmiumBridge?.fetchSubtitleFromPlayerApi((trackUrl, text, mid, bcp47) => {
              this.emitSubtitleData(trackUrl, text, true, mid, bcp47);
            }, true);
          }, 300);
        }
      },
      onTimeSync: (payload) => {
        window.postMessage({ type: NCW_MESSAGE_TYPES.TIME_SYNC, ...payload }, '*');
      },
      onSubtitleTrackChange: (track, sessionId, isOff) => {
        if (this.isProbingNativeTrack) {
          this.logger.info(
            'Netflix',
            'Ignoring track change event while probing native track.'
          );
          return;
        }

        const currentActiveId = this.kadmiumBridge?.extractVideoId(window.location.href);
        const effectiveMovieId = this.lastInterceptedSubtitle?.movieId || currentActiveId;

        if (isOff) {
          this.logger.info(
            'Netflix',
            `Text track turned OFF in session ${sessionId}. Posting SUBTITLE_OFF.`
          );
          window.postMessage(
            {
              type: NCW_MESSAGE_TYPES.SUBTITLE_OFF,
              movieId: effectiveMovieId,
              timestamp: Date.now(),
            },
            '*'
          );
        } else if (track) {
          this.logger.info(
            'Netflix',
            `Text track switched to candidate in session ${sessionId}. Extracting subtitle from player API...`
          );
          this.kadmiumBridge?.fetchSubtitleFromPlayerApi(
            (trackUrl, text, mid, bcp47) => {
              this.emitSubtitleData(trackUrl, text, true, mid, bcp47);
            },
            true,
            0,
            track
          );
        }
      },
    });

    this.kadmiumBridge.start();
  }

  private setupMetadataInterceptor(): void {
    this.unhookMetadata = NetworkHook.onMetadataPayload((_url, data) => {
      this.handleMetadataPayload(data);
    });
  }

  private emitMetadataForEpisode(targetEpisodeId?: string): boolean {
    if (!this.cachedShowMetadata) return false;
    const v = this.cachedShowMetadata;
    const showId = String(v.id || '');
    const showTitle = String(v.title || '');
    const showSynopsis = typeof v.synopsis === 'string' ? v.synopsis : undefined;

    const targetId = targetEpisodeId || this.extractVideoId(window.location.href);

    let matchedSeason: any = null;
    let matchedEpisode: any = null;

    if (Array.isArray(v.seasons)) {
      // 1. Match directly against episodes in all seasons
      if (targetId) {
        for (const season of v.seasons) {
          if (Array.isArray(season.episodes)) {
            const ep = season.episodes.find((e: any) => String(e.id || e.episodeId) === targetId);
            if (ep) {
              matchedSeason = season;
              matchedEpisode = ep;
              break;
            }
          }
        }
      }

      // 2. If targetId was not an episode (e.g. it was a seasonId or missing), match via currentEpisode pointer
      if (!matchedEpisode && (!targetId || targetId === showId)) {
        const currentEpId = v.currentEpisode ? String(v.currentEpisode) : '';
        if (currentEpId) {
          for (const season of v.seasons) {
            if (Array.isArray(season.episodes)) {
              const ep = season.episodes.find(
                (e: any) => String(e.id || e.episodeId) === currentEpId
              );
              if (ep) {
                matchedSeason = season;
                matchedEpisode = ep;
                break;
              }
            }
          }
        }
      }
    }

    // 3. Standalone movie check
    if (!matchedEpisode && targetId && String(v.id) === targetId) {
      matchedEpisode = {
        id: v.id,
        title: showTitle,
        synopsis: showSynopsis,
      };
    }

    // If targetId was specified but cannot be found in this show, this cached metadata belongs to another show
    if (targetId && !matchedEpisode) {
      return false;
    }

    const payload: InjectedMetadataLoadedPayload = {
      type: NCW_MESSAGE_TYPES.METADATA_LOADED,
      showId,
      showTitle,
      showSynopsis,
      seasonId: matchedSeason ? String(matchedSeason.id || '') : undefined,
      seasonTitle: matchedSeason ? String(matchedSeason.title || '') : undefined,
      seasonSeq:
        matchedSeason && typeof matchedSeason.seq === 'number'
          ? Number(matchedSeason.seq)
          : undefined,
      currentEpisode: matchedEpisode
        ? {
            episodeId: String(matchedEpisode.id || matchedEpisode.episodeId || targetId || ''),
            episodeTitle: String(matchedEpisode.title || ''),
            episodeSeq: matchedEpisode.seq !== undefined ? Number(matchedEpisode.seq) : undefined,
            episodeSynopsis:
              typeof matchedEpisode.synopsis === 'string' ? matchedEpisode.synopsis : undefined,
          }
        : undefined,
    };

    const emittedMid = payload.currentEpisode?.episodeId || targetId || showId;
    this.lastHandledMetadataMovieId = emittedMid;
    this.logger.info(
      'Netflix',
      `📺 Metadata parsed: Show "${showTitle}" (showId=${showId}, ep=${payload.currentEpisode?.episodeTitle || 'N/A'})`
    );

    // Sync to dataset for synchronous DOM reads
    if (document.documentElement && document.documentElement.dataset) {
      if (showId) document.documentElement.dataset.ncwShowId = showId;
      if (showTitle) document.documentElement.dataset.ncwMainTitle = showTitle;
      if (showSynopsis) document.documentElement.dataset.ncwShowSummary = showSynopsis;
      if (payload.seasonId) document.documentElement.dataset.ncwSeasonId = payload.seasonId;
      if (payload.currentEpisode) {
        if (payload.currentEpisode.episodeTitle) {
          document.documentElement.dataset.ncwEpisodeTitle = payload.currentEpisode.episodeTitle;
        }
        if (payload.currentEpisode.episodeSynopsis) {
          document.documentElement.dataset.ncwEpisodeSummary =
            payload.currentEpisode.episodeSynopsis;
        }
      }
    }

    window.postMessage(payload, '*');
    return true;
  }

  private handleMetadataPayload(data: any): void {
    if (!data || !data.video) return;
    this.cachedShowMetadata = data.video;
    const currentMid = this.extractVideoId(window.location.href);
    this.emitMetadataForEpisode(currentMid || undefined);
  }

  private async ensureMetadata(movieId: string, immediate = false): Promise<void> {
    if (!movieId) return;
    if (!immediate && this.lastHandledMetadataMovieId === movieId) return;

    if (this.emitMetadataForEpisode(movieId)) {
      return;
    }

    const doFetch = async () => {
      if (!immediate && this.lastHandledMetadataMovieId === movieId) return;
      if (this.emitMetadataForEpisode(movieId)) return;
      try {
        this.logger.info(
          'Netflix',
          `Proactively fetching Netflix metadata for movie/episode ${movieId}`
        );
        const metadataUrl = `/nq/website/memberapi/release/metadata?isVolatileBillboardsEnabled=true&movieid=${movieId}&imageFormat=webp&withSize=true&materialize=true&_=${Date.now()}`;
        const res = await fetch(metadataUrl, {
          credentials: 'include',
          headers: {
            Accept: 'application/json, text/plain, */*',
          },
        });
        if (res.ok) {
          const data = await res.json();
          this.handleMetadataPayload(data);
        }
      } catch (err) {
        this.logger.warn('Netflix', 'Failed to fetch metadata proactively:', err);
      }
    };

    if (immediate) {
      doFetch();
    } else {
      setTimeout(doFetch, 1500);
    }
  }

  private setupNetworkInterceptor(): void {
    this.unhookNetwork = NetworkHook.onSubtitlePayload((url, text) => {
      this.emitSubtitleData(url, text);
    });
  }

  private setupMessageListener(): void {
    window.addEventListener('message', (event) => {
      if (event.source !== window || !event.data) return;
      if (event.data.type === NCW_MESSAGE_TYPES.REQUEST_SUBTITLE_RETRY) {
        const currentMid = this.extractVideoId(window.location.href);
        this.lastEmittedSignature = '';

        if (currentMid && this.preloadedSubtitlesByMovieId.has(currentMid)) {
          const preloaded = this.preloadedSubtitlesByMovieId.get(currentMid)!;
          this.preloadedSubtitlesByMovieId.delete(currentMid);
          this.logger.info(
            'Netflix',
            `⚡ Re-emitting preloaded subtitle for new episode (${currentMid}).`
          );
          this.emitSubtitleData(preloaded.url, preloaded.text, true, currentMid, preloaded.bcp47);
          return;
        }

        if (
          this.latestUnknownPreload &&
          Date.now() - this.latestUnknownPreload.timestamp < 300000
        ) {
          const preloaded = this.latestUnknownPreload;
          this.latestUnknownPreload = null;
          this.logger.info(
            'Netflix',
            `⚡ Re-emitting unknown preloaded subtitle for new episode (${currentMid}).`
          );
          this.emitSubtitleData(preloaded.url, preloaded.text, true, currentMid, preloaded.bcp47);
          return;
        }

        if (
          this.lastInterceptedSubtitle &&
          this.lastInterceptedSubtitle.text &&
          (!currentMid || this.lastInterceptedSubtitle.movieId === currentMid)
        ) {
          this.logger.info(
            'Netflix',
            `Re-emitting cached subtitle from memory for episode (${currentMid || 'active'}).`
          );
          window.postMessage(
            {
              type: NCW_MESSAGE_TYPES.SUBTITLE_RAW_DATA,
              movieId: this.lastInterceptedSubtitle.movieId,
              url: this.lastInterceptedSubtitle.url,
              rawText: this.lastInterceptedSubtitle.text,
              bcp47: this.lastInterceptedSubtitle.bcp47 || null,
              timestamp: Date.now(),
              isReplay: true,
            },
            '*'
          );
        }

        this.kadmiumBridge?.fetchSubtitleFromPlayerApi((trackUrl, text, movieId, bcp47) => {
          this.emitSubtitleData(trackUrl, text, true, movieId, bcp47);
        }, true);
      }

      if (event.data.type === NCW_MESSAGE_TYPES.QUERY_NATIVE_TRACK) {
        const { movieId, targetLangCode } = event.data;
        const currentMid = movieId || this.extractVideoId(window.location.href) || '';
        this.logger.info(
          'Netflix',
          `Received query for native track: movieId=${currentMid}, targetLang=${targetLangCode}`
        );

        this.fetchNativeTrackByLanguage(currentMid, targetLangCode, (result) => {
          window.postMessage(
            {
              type: NCW_MESSAGE_TYPES.NATIVE_TRACK_DATA,
              movieId: currentMid,
              targetLangCode,
              found: result.found,
              bcp47: result.bcp47,
              rawText: result.rawText,
              error: result.error,
            },
            '*'
          );
        });
      }

      if (event.data.type === NCW_MESSAGE_TYPES.REQUEST_METADATA) {
        const targetMid = event.data.movieId ? String(event.data.movieId) : null;
        if (targetMid) {
          this.logger.info(
            'Netflix',
            `Received REQUEST_METADATA message for episode (${targetMid}).`
          );
          if (!this.emitMetadataForEpisode(targetMid)) {
            this.ensureMetadata(targetMid, true);
          }
        }
      }
    });
  }

  private extractVideoId(url: string | null | undefined): string | null {
    const match = (url || '').match(/\/watch\/(\d+)/);
    return match ? match[1] : null;
  }

  private urlsMatchSubtitleTrack(candidateUrl: string | null, targetUrl: string | null): boolean {
    if (!candidateUrl || !targetUrl) return false;
    if (candidateUrl === targetUrl) return true;

    const t1 = (candidateUrl.match(/[?&]t=([^&]+)/) || [])[1];
    const t2 = (targetUrl.match(/[?&]t=([^&]+)/) || [])[1];
    if (t1 && t2 && t1 === t2) return true;

    try {
      const p1 = new URL(candidateUrl, window.location.origin).pathname;
      const p2 = new URL(targetUrl, window.location.origin).pathname;
      if (p1 && p2 && p1 !== '/' && p1 === p2) return true;
    } catch {}

    const clean1 = candidateUrl.split('?')[0];
    const clean2 = targetUrl.split('?')[0];
    if (clean1 && clean2 && clean1 !== 'https://' && clean1 !== 'http://') {
      if (clean1 === clean2) return true;
      const path1 = clean1.replace(/^https?:\/\/[^/]+/, '');
      const path2 = clean2.replace(/^https?:\/\/[^/]+/, '');
      if (path1 && path2 && path1 !== '/' && path1 === path2) return true;
    }

    return false;
  }

  private findTrackInfoForSubtitleUrl(
    url: string | null
  ): { movieId: string | null; bcp47: string | null; trackId: string | null } | null {
    if (!url) return null;
    try {
      const vp = window.netflix?.appContext?.state?.playerApp?.getAPI()?.videoPlayer;
      if (!vp) return null;
      const sessions = vp.getAllPlayerSessionIds?.() || [];

      for (const sid of sessions) {
        const p = vp.getVideoPlayerBySessionId(sid);
        if (!p) continue;
        const internalP = typeof p.getInternalPlayer === 'function' ? p.getInternalPlayer() : null;
        const mid = p.getMovieId?.();

        // 1. Check current segment timedTextTrack
        const currentTrack = internalP?.playback?.currentSegment?.tracks?.timedTextTrack;
        const currentTrackUrls = currentTrack?.urls || [];
        for (const trackUrl of currentTrackUrls) {
          if (this.urlsMatchSubtitleTrack(trackUrl.url || trackUrl, url)) {
            return {
              movieId: mid ? String(mid) : null,
              bcp47: currentTrack?.bcp47 || currentTrack?.language || null,
              trackId: currentTrack?.trackId || currentTrack?.id || null,
            };
          }
        }

        // 2. Check getPlayerTextTracks()
        const playerTextTracks: any[] =
          typeof internalP?.getPlayerTextTracks === 'function'
            ? internalP.getPlayerTextTracks() || []
            : [];
        for (const pt of playerTextTracks) {
          if (!pt) continue;
          const ptUrls = Array.isArray(pt.urls) ? pt.urls : [];
          for (const u of ptUrls) {
            if (this.urlsMatchSubtitleTrack(u?.url || u, url)) {
              return {
                movieId: mid ? String(mid) : null,
                bcp47: pt.bcp47 || pt.language || null,
                trackId: pt.trackId || pt.id || null,
              };
            }
          }
        }

        // 3. Check getTimedTextTrackList()
        if (typeof p.getTimedTextTrackList === 'function') {
          const trackList = p.getTimedTextTrackList() || [];
          for (const t of trackList) {
            if (!t) continue;
            const extracted = this.kadmiumBridge?.extractUrlsFromDownloadableEntry(t) || [];
            for (const eu of extracted) {
              if (this.urlsMatchSubtitleTrack(eu, url)) {
                return {
                  movieId: mid ? String(mid) : null,
                  bcp47: t.bcp47 || t.language || null,
                  trackId: t.trackId || t.id || null,
                };
              }
            }
          }
        }
      }
    } catch (e) {
      this.logger.warn('Netflix', 'Exception in findTrackInfoForSubtitleUrl:', e);
    }
    return null;
  }

  private emitSubtitleData(
    url: string | null,
    text: string | null,
    force = false,
    explicitMovieId: string | null = null,
    explicitBcp47: string | null = null
  ): void {
    try {
      if (!text || text.length < 50) return;

      // 0. Only emit subtitles if currently on a watch page!
      const currentActiveId = this.extractVideoId(window.location.href);
      if (!currentActiveId) {
        return;
      }

      // Intercept and absorb subtitle payload if an active native track probe is running
      if (this.isProbingNativeTrack) {
        if (this.activeNativeTrackProbe) {
          this.activeNativeTrackProbe(url, text);
        }
        return;
      }

      // 1. 获取当前播放器及当前用户选中的字幕轨道 (getTextTrack / getTimedTextTrack)
      const activePlayer = this.kadmiumBridge?.getActivePlayer();
      const targetPlayer = activePlayer?.player;
      const internalP = typeof targetPlayer?.getInternalPlayer === 'function'
        ? targetPlayer.getInternalPlayer()
        : null;

      let currentTrack: any = null;
      if (typeof internalP?.getTextTrack === 'function') {
        currentTrack = internalP.getTextTrack();
      } else if (typeof targetPlayer?.getTimedTextTrack === 'function') {
        currentTrack = targetPlayer.getTimedTextTrack();
      }

      // 用户未开启字幕或选了关闭，直接丢弃
      if (!currentTrack || this.kadmiumBridge?.isTimedTextTrackOff(currentTrack)) {
        return;
      }

      const currentTrackId = currentTrack.trackId || currentTrack.id;
      const currentBcp = (currentTrack.bcp47 || currentTrack.language || '').toLowerCase().trim();
      const currentMovieId = String(targetPlayer?.getMovieId?.() || currentActiveId || '');

      // 2. 校验轨道信息与剧集归属 (Episode & Track Lookup)
      const trackMatch = this.findTrackInfoForSubtitleUrl(url);
      const subtitleMovieId = explicitMovieId || trackMatch?.movieId;
      let trackBcp47 = explicitBcp47 || trackMatch?.bcp47 || null;

      // 3. 从 TTML/XML 内容头部提取语言标识兜底
      if (!trackBcp47 && text) {
        const langMatch =
          text.slice(0, 1000).match(/xml:lang=["']([^"']+)["']/i) ||
          text.slice(0, 1000).match(/lang=["']([^"']+)["']/i);
        if (langMatch && langMatch[1]) {
          trackBcp47 = langMatch[1].trim();
        }
      }

      // 4. 从 getPlayerTextTracks() 比对 URL 是不是属于当前用户选中的字幕
      const playerTextTracks: any[] =
        typeof internalP?.getPlayerTextTracks === 'function'
          ? internalP.getPlayerTextTracks() || []
          : [];

      const activePlayerTrack = playerTextTracks.find((pt: any) => {
        if (!pt) return false;
        if (currentTrackId && (pt.trackId === currentTrackId || pt.id === currentTrackId)) return true;
        const ptBcp = (pt.bcp47 || pt.language || '').toLowerCase().trim();
        return currentBcp && ptBcp === currentBcp;
      });

      // 核心校验：如果传入了实际 URL，去 getPlayerTextTracks 比对
      if (url && !force && url !== 'player://internalP.getPlayerTextTracks/downloadPromise') {
        const isUrlOfCurrentTrack = Boolean(
          activePlayerTrack &&
          Array.isArray(activePlayerTrack.urls) &&
          activePlayerTrack.urls.some((u: any) => this.urlsMatchSubtitleTrack(u?.url || u, url))
        );

        if (!isUrlOfCurrentTrack) {
          // 检查该 URL 是否属于其他已知的 text track（例如后台查询目标语言抓取的轨道）
          const matchedOtherTrack = playerTextTracks.find((pt: any) =>
            Array.isArray(pt.urls) && pt.urls.some((u: any) => this.urlsMatchSubtitleTrack(u?.url || u, url))
          );
          if (matchedOtherTrack) {
            const otherBcp = (matchedOtherTrack.bcp47 || matchedOtherTrack.language || '').toLowerCase().trim();
            this.logger.info(
              'Netflix',
              `Dropping subtitle payload: URL belongs to track (${otherBcp || matchedOtherTrack.trackId}), but user active track is (${currentBcp || currentTrackId}).`
            );
            return;
          }

          // 如果 trackMatch 中匹配到的 trackId 与当前激活轨道不符，坚决丢弃
          if (trackMatch?.trackId && currentTrackId && trackMatch.trackId !== currentTrackId) {
            this.logger.info(
              'Netflix',
              `Dropping subtitle payload: URL trackId (${trackMatch.trackId}) does not match active trackId (${currentTrackId}).`
            );
            return;
          }
        }
      }

      // 5. 校验语言是否与当前激活轨道严格匹配
      const payloadBcp = (trackBcp47 || '').toLowerCase().trim();
      if (
        currentBcp &&
        payloadBcp &&
        currentBcp !== payloadBcp &&
        !currentBcp.startsWith(payloadBcp) &&
        !payloadBcp.startsWith(currentBcp)
      ) {
        this.logger.info(
          'Netflix',
          `Dropping subtitle payload: language (${payloadBcp}) does not match user active track (${currentBcp}).`
        );
        return;
      }

      // Suppress residual payloads from probed track
      if (this.probingTargetBcp) {
        if (payloadBcp && (payloadBcp.includes(this.probingTargetBcp) || this.probingTargetBcp.includes(payloadBcp))) {
          this.logger.info(
            'Netflix',
            `Suppressing residual probe subtitle payload for ${this.probingTargetBcp}.`
          );
          return;
        }
      }

      const v = document.querySelector('video');
      const isActivelyPlaying = v && !v.paused && v.currentTime > 30;

      // 1. Preloaded episode
      if (subtitleMovieId && currentMovieId && subtitleMovieId !== currentMovieId) {
        this.logger.info(
          'Netflix',
          `📦 Staged preloaded subtitle for upcoming episode (${subtitleMovieId}). Current episode (${currentMovieId}) continues.`
        );
        this.preloadedSubtitlesByMovieId.set(subtitleMovieId, {
          url,
          text,
          bcp47: trackBcp47,
          timestamp: Date.now(),
        });
        window.postMessage(
          {
            type: NCW_MESSAGE_TYPES.SUBTITLE_PRELOAD_STAGED,
            movieId: subtitleMovieId,
            url,
            rawText: text,
            bcp47: trackBcp47,
            timestamp: Date.now(),
          },
          '*'
        );
        return;
      }

      // 2. Unknown incoming preload
      if (
        !subtitleMovieId &&
        currentMovieId &&
        isActivelyPlaying &&
        this.lastInterceptedSubtitle?.text
      ) {
        this.logger.info(
          'Netflix',
          `📦 Staged unknown incoming subtitle as next episode preload (currentTime=${v.currentTime.toFixed(1)}s, activeId=${currentMovieId}).`
        );
        this.latestUnknownPreload = { url, text, bcp47: trackBcp47, timestamp: Date.now() };
        window.postMessage(
          {
            type: NCW_MESSAGE_TYPES.SUBTITLE_PRELOAD_STAGED,
            movieId: null,
            url,
            rawText: text,
            bcp47: trackBcp47,
            timestamp: Date.now(),
          },
          '*'
        );
        return;
      }

      const effectiveMovieId = subtitleMovieId || currentMovieId;

      this.lastInterceptedSubtitle = {
        movieId: effectiveMovieId,
        url: url || window.location.href,
        text,
        bcp47: trackBcp47,
        timestamp: Date.now(),
      };

      const signature = `${effectiveMovieId || ''}_${text.length}_${text.slice(0, 80)}_${text.slice(-80)}`;
      if (!force && signature === this.lastEmittedSignature) {
        return;
      }
      this.lastEmittedSignature = signature;

      window.postMessage(
        {
          type: NCW_MESSAGE_TYPES.SUBTITLE_RAW_DATA,
          movieId: effectiveMovieId,
          url: url || window.location.href,
          pageUrl: window.location.href,
          rawText: text,
          bcp47: trackBcp47,
          timestamp: Date.now(),
        },
        '*'
      );
      this.logger.info(
        'Netflix',
        `Intercepted subtitle payload for episode (${effectiveMovieId || 'active'}):`,
        url ? url.slice(0, 80) : 'unknown'
      );
    } catch (e) {
      this.logger.error('Netflix', 'Failed to post subtitle message:', e);
    }
  }

  private matchesLanguage(track: any, targetLangCode: string): boolean {
    if (!track || track.isNone || track.trackType === 'OFF') return false;
    const bcp = (track.bcp47 || track.language || track.lang || '').toLowerCase().trim();
    if (!bcp) return false;
    const target = (targetLangCode || '').toLowerCase().trim();

    // 1. Direct match
    if (bcp === target) return true;

    // 2. Chinese language family handling
    const isTargetHans = target === 'zh-cn' || target === 'zh-hans' || target === 'zh';
    const isTargetHant = target === 'zh-tw' || target === 'zh-hant' || target === 'zh-hk';
    const dispName = (track.displayName || '').toLowerCase();

    if (isTargetHans) {
      if (bcp === 'zh-hans' || bcp === 'zh-cn' || bcp === 'zh-sg') return true;
      if (bcp === 'zh' && !dispName.includes('繁體') && !dispName.includes('traditional')) return true;
      return false;
    }

    if (isTargetHant) {
      if (bcp === 'zh-hant' || bcp === 'zh-tw' || bcp === 'zh-hk' || bcp === 'zh-mo') return true;
      if (bcp === 'zh' && (dispName.includes('繁體') || dispName.includes('traditional'))) return true;
      return false;
    }

    // 3. Prefix matching (e.g. target "en" matches "en-us", "en-gb"; or target "en-us" matches "en")
    if (bcp.startsWith(target + '-') || target.startsWith(bcp + '-')) {
      return true;
    }

    // 4. Base code comparison (e.g. "es-419" vs "es")
    const bcpBase = bcp.split('-')[0];
    const targetBase = target.split('-')[0];
    if (bcpBase && bcpBase === targetBase && bcpBase !== 'zh') {
      return true;
    }

    return false;
  }

  private findBestMatchingTrack(trackList: any[], targetLangCode: string): any {
    const candidates = trackList.filter((t) => this.matchesLanguage(t, targetLangCode));
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    // Filter out forced narrative tracks first
    const nonForced = candidates.filter(
      (t) =>
        !t.isForcedNarrative &&
        t.rawTrackType !== 'forced' &&
        t.trackType !== 'FORCED' &&
        !t.displayName?.toLowerCase().includes('forced')
    );
    const pool = nonForced.length > 0 ? nonForced : candidates;

    // Prefer standard dialogue over CC / SDH (unless only CC exists)
    const standard = pool.filter(
      (t) =>
        t.trackType !== 'ASSISTIVE' &&
        !t.displayName?.toLowerCase().includes('cc') &&
        !t.displayName?.toLowerCase().includes('sdh')
    );
    return standard[0] || pool[0];
  }

  private async fetchNativeTrackByLanguage(
    _movieId: string,
    targetLanguageCode: string,
    onResult: (res: { found: boolean; rawText?: string; bcp47?: string; error?: string }) => void
  ): Promise<void> {
    if (this.isProbingNativeTrack) {
      this.logger.warn(
        'Netflix',
        'A native track probe is already in progress, skipping duplicate query.'
      );
      onResult({ found: false, error: 'Probe already in progress' });
      return;
    }

    try {
      const active = this.kadmiumBridge?.getActivePlayer();
      const targetPlayer = active?.player;
      if (!targetPlayer) {
        this.logger.info(
          'Netflix',
          'No active player session found for native track query.'
        );
        onResult({ found: false, error: 'No active player session' });
        return;
      }

      const internalP =
        typeof targetPlayer.getInternalPlayer === 'function'
          ? targetPlayer.getInternalPlayer()
          : null;

      // 1. Get track list from internal player or target player
      let trackList: any[] = [];
      if (typeof internalP?.getTextTrackList === 'function') {
        trackList = internalP.getTextTrackList() || [];
      } else if (typeof targetPlayer.getTimedTextTrackList === 'function') {
        trackList = targetPlayer.getTimedTextTrackList() || [];
      }

      if (!trackList || trackList.length === 0) {
        const fallback = internalP?.playback?.timedTextTracks || [];
        trackList = Array.isArray(fallback) ? fallback : [];
      }

      this.logger.info(
        'Netflix',
        `fetchNativeTrackByLanguage: available tracks count = ${trackList.length}, targetLang = ${targetLanguageCode}`
      );

      // 2. Find matching track for target language
      const matchedTrack = this.findBestMatchingTrack(trackList, targetLanguageCode);
      if (!matchedTrack) {
        this.logger.info(
          'Netflix',
          `No native track matching target language "${targetLanguageCode}" found among available tracks.`
        );
        onResult({ found: false });
        return;
      }

      const matchedBcp = matchedTrack.bcp47 || matchedTrack.language || targetLanguageCode;
      this.logger.info(
        'Netflix',
        `Found candidate native track: "${matchedTrack.displayName || matchedBcp}" (bcp47=${matchedBcp})`
      );

      // 3. Get currently selected track
      let currentTrack: any = null;
      if (typeof internalP?.getTextTrack === 'function') {
        currentTrack = internalP.getTextTrack();
      } else if (typeof targetPlayer.getTimedTextTrack === 'function') {
        currentTrack = targetPlayer.getTimedTextTrack();
      }

      // 4. If current track is already the matched track, check if we already have the subtitle in memory
      const currentBcp = (currentTrack?.bcp47 || currentTrack?.language || '').toLowerCase();
      const matchedBcpLower = String(matchedBcp).toLowerCase();
      const isAlreadyActive =
        currentTrack === matchedTrack ||
        (currentBcp &&
          (currentBcp === matchedBcpLower ||
            this.matchesLanguage(currentTrack, targetLanguageCode)));

      if (isAlreadyActive && this.lastInterceptedSubtitle?.text) {
        this.logger.info(
          'Netflix',
          `Target track ${matchedBcp} is already active, returning cached subtitle text.`
        );
        onResult({
          found: true,
          rawText: this.lastInterceptedSubtitle.text,
          bcp47: matchedBcp,
        });
        return;
      }

      // 4.1 Check if matchedTrack already has direct downloadable URLs or downloadPromise in getPlayerTextTracks()
      const playerTextTracks: any[] =
        typeof internalP?.getPlayerTextTracks === 'function'
          ? internalP.getPlayerTextTracks() || []
          : [];

      const matchedId = matchedTrack.trackId || matchedTrack.id;
      const matchedPlayerTrack = playerTextTracks.find((pt: any) => {
        if (!pt) return false;
        if (matchedId && (pt.trackId === matchedId || pt.id === matchedId)) return true;
        const ptBcp = (pt.bcp47 || pt.language || '').toLowerCase().trim();
        return matchedBcpLower && ptBcp === matchedBcpLower;
      });

      if (matchedPlayerTrack?.downloadPromise) {
        try {
          const rawText = await Promise.resolve(matchedPlayerTrack.downloadPromise);
          if (typeof rawText === 'string' && rawText.length > 50) {
            this.logger.info(
              'Netflix',
              `Native track content for ${matchedBcp} retrieved directly from playerTextTrack.downloadPromise.`
            );
            onResult({ found: true, rawText, bcp47: matchedBcp });
            return;
          }
        } catch {
          // Fall through
        }
      }

      let directUrl: string | null = null;
      const directUrls = this.kadmiumBridge?.extractUrlsFromDownloadableEntry(matchedPlayerTrack || matchedTrack) || [];
      if (directUrls.length > 0) {
        directUrl = directUrls[0];
      }

      if (directUrl) {
        this.logger.info(
          'Netflix',
          `Directly fetching native track content for ${matchedBcp} without switching player text track...`
        );
        try {
          const res = await window.fetch(directUrl);
          if (res.ok) {
            const rawText = await res.text();
            if (rawText && rawText.length > 50) {
              onResult({ found: true, rawText, bcp47: matchedBcp });
              return;
            }
          }
          onResult({ found: false, error: 'Empty text from direct track URL' });
          return;
        } catch (err) {
          this.logger.warn('Netflix', 'Direct track fetch failed:', err);
          onResult({ found: false, error: String(err) });
          return;
        }
      }

      // 5. Trigger probe: temporarily switch to matchedTrack, capture subtitle, then switch back
      this.isProbingNativeTrack = true;
      this.probingTargetBcp = String(matchedBcp).toLowerCase();
      this.kadmiumBridge?.setProbingNativeTrack(true);
      let resolved = false;
      let timer: any = null;
      const originalTrack = currentTrack;

      const switchBack = () => {
        try {
          this.logger.info(
            'Netflix',
            `Switching back to user's original text track (${originalTrack?.displayName || originalTrack?.bcp47 || 'none'}).`
          );
          if (originalTrack && !originalTrack.isNone) {
            if (typeof internalP?.setTextTrack === 'function') {
              internalP.setTextTrack(originalTrack);
            } else if (typeof targetPlayer.setTimedTextTrack === 'function') {
              targetPlayer.setTimedTextTrack(originalTrack);
            }
          } else {
            // If original was None / Off, select the Off track
            const noneTrack = trackList.find((t) => t.isNone || t.trackType === 'OFF');
            if (noneTrack) {
              if (typeof internalP?.setTextTrack === 'function') {
                internalP.setTextTrack(noneTrack);
              } else if (typeof targetPlayer.setTimedTextTrack === 'function') {
                targetPlayer.setTimedTextTrack(noneTrack);
              }
            } else if (originalTrack) {
              if (typeof internalP?.setTextTrack === 'function') {
                internalP.setTextTrack(originalTrack);
              }
            }
          }
        } catch (err) {
          this.logger.warn('Netflix', 'Error switching back to original text track:', err);
        }
      };

      const finish = (result: {
        found: boolean;
        rawText?: string;
        bcp47?: string;
        error?: string;
      }) => {
        if (resolved) return;
        resolved = true;
        this.isProbingNativeTrack = false;
        this.kadmiumBridge?.setProbingNativeTrack(false);
        this.activeNativeTrackProbe = null;
        if (timer) clearTimeout(timer);
        setTimeout(switchBack, 60);
        if (this.probeSuppressTimer) clearTimeout(this.probeSuppressTimer);
        this.probeSuppressTimer = setTimeout(() => {
          this.probingTargetBcp = null;
        }, 4000);
        onResult(result);
      };

      // Set probe interceptor
      this.activeNativeTrackProbe = (_url: string | null, text: string) => {
        if (resolved) return false;
        if (text && text.length > 50) {
          this.logger.info(
            'Netflix',
            `🎯 Native track probe successfully captured subtitle for ${matchedBcp} (${text.length} chars).`
          );
          finish({
            found: true,
            rawText: text,
            bcp47: matchedBcp,
          });
          return true; // Intercepted: do not emit as primary subtitle!
        }
        return false;
      };

      // 6. Execute temporary track switch
      this.logger.info(
        'Netflix',
        `Probing native track: calling setTextTrack for ${matchedBcp}...`
      );

      if (typeof internalP?.setTextTrack === 'function') {
        internalP.setTextTrack(matchedTrack);
      } else if (typeof targetPlayer.setTimedTextTrack === 'function') {
        targetPlayer.setTimedTextTrack(matchedTrack);
      } else {
        this.isProbingNativeTrack = false;
        this.activeNativeTrackProbe = null;
        onResult({ found: false, error: 'setTextTrack method not available on player' });
        return;
      }

      // Check fallback after 350ms in case URLs are populated in currentSegment
      setTimeout(async () => {
        if (resolved) return;
        try {
          const timedTrack = internalP?.playback?.currentSegment?.tracks?.timedTextTrack;
          const urls = this.kadmiumBridge?.extractUrlsFromDownloadableEntry(timedTrack) || [];
          if (urls.length > 0 && !resolved) {
            this.logger.info(
              'Netflix',
              `Probe found downloadable URL for ${matchedBcp}, fetching directly...`
            );
            const res = await window.fetch(urls[0]);
            if (res.ok) {
              const rawText = await res.text();
              if (rawText && rawText.length > 50) {
                finish({
                  found: true,
                  rawText,
                  bcp47: matchedBcp,
                });
              }
            }
          }
        } catch (e) {
          this.logger.warn('Netflix', 'Fallback fetch for native track failed:', e);
        }
      }, 350);

      // Safety timeout: 2000ms
      timer = setTimeout(() => {
        if (resolved) return;
        this.logger.warn(
          'Netflix',
          `Native track probe timed out for language ${targetLanguageCode}.`
        );
        finish({ found: false, error: 'Probe timeout' });
      }, 2000);
    } catch (err: any) {
      this.isProbingNativeTrack = false;
      this.kadmiumBridge?.setProbingNativeTrack(false);
      this.activeNativeTrackProbe = null;
      this.logger.warn('Netflix', 'Exception in fetchNativeTrackByLanguage probe:', err);
      onResult({ found: false, error: err?.message || String(err) });
    }
  }
}
