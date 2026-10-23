import { Logger } from '@shared/utils/logger';

declare global {
  interface Window {
    netflix?: any;
  }
}

export interface KadmiumActivePlayer {
  player: any;
  sessionId: string;
}

export class KadmiumPlayerBridge {
  private lastObservedMovieId: string | number | null = null;
  private lastAdState = false;
  private lastReportedSegmentTime: number | null = null;
  private checkIntervalTimer: any = null;
  private lastTimeUpdateSync = 0;

  private onAdStateChangeHandler?: (isAd: boolean) => void;
  private onEpisodeChangeHandler?: (movieId: string, sessionId: string, url: string) => void;
  private onTimeSyncHandler?: (payload: {
    segmentTime: number;
    syncAt: number;
    isPaused: boolean;
    playbackRate: number;
    cadmiumOffset: number;
    adOffset: number;
    source: string;
  }) => void;
  private onSubtitleTrackChangeHandler?: (track: any, sessionId: string, isOff: boolean) => void;

  private lastTrackBySession: Map<string, { trackId: string; isOff: boolean }> = new Map();
  private isProbingNativeTrack = false;

  private logger: Logger = new Logger('KadmiumPlayerBridge');

  constructor(handlers: {
    onAdStateChange?: (isAd: boolean) => void;
    onEpisodeChange?: (movieId: string, sessionId: string, url: string) => void;
    onTimeSync?: (payload: any) => void;
    onSubtitleTrackChange?: (track: any, sessionId: string, isOff: boolean) => void;
  }) {
    this.onAdStateChangeHandler = handlers.onAdStateChange;
    this.onEpisodeChangeHandler = handlers.onEpisodeChange;
    this.onTimeSyncHandler = handlers.onTimeSync;
    this.onSubtitleTrackChangeHandler = handlers.onSubtitleTrackChange;

    this.checkKadmiumPlayerState = this.checkKadmiumPlayerState.bind(this);
  }

  start(): void {
    this.stop();

    // Listen to video element timeline / playback events
    window.addEventListener('seeked', this.onSeeked, { capture: true, passive: true });
    window.addEventListener('playing', this.onPlaying, { capture: true, passive: true });
    window.addEventListener('pause', this.onPause, { capture: true, passive: true });
    window.addEventListener('ratechange', this.onRateChange, { capture: true, passive: true });
    window.addEventListener('timeupdate', this.onTimeUpdate, { capture: true, passive: true });

    this.checkIntervalTimer = setInterval(() => {
      this.checkKadmiumPlayerState();
    }, 500);
  }

  stop(): void {
    if (this.checkIntervalTimer) {
      clearInterval(this.checkIntervalTimer);
      this.checkIntervalTimer = null;
    }
    window.removeEventListener('seeked', this.onSeeked);
    window.removeEventListener('playing', this.onPlaying);
    window.removeEventListener('pause', this.onPause);
    window.removeEventListener('ratechange', this.onRateChange);
    window.removeEventListener('timeupdate', this.onTimeUpdate);
  }

  private onSeeked = () => {
    this.checkKadmiumPlayerState();
    setTimeout(this.checkKadmiumPlayerState, 80);
  };

  private onPlaying = () => {
    setTimeout(this.checkKadmiumPlayerState, 80);
  };

  private onPause = () => {
    setTimeout(this.checkKadmiumPlayerState, 30);
  };

  private onRateChange = () => {
    setTimeout(this.checkKadmiumPlayerState, 30);
  };

  private onTimeUpdate = () => {
    const now = performance.now();
    if (now - this.lastTimeUpdateSync > 200) {
      this.lastTimeUpdateSync = now;
      this.checkKadmiumPlayerState();
    }
  };

  extractVideoId(url: string | null | undefined): string | null {
    const match = (url || '').match(/\/watch\/(\d+)/);
    return match ? match[1] : null;
  }

  getActivePlayer(): KadmiumActivePlayer | null {
    try {
      const currentUrlMovieId = this.extractVideoId(window.location.href);

      const vp = window.netflix?.appContext?.state?.playerApp?.getAPI()?.videoPlayer;
      if (!vp) return null;
      const sessions = vp.getAllPlayerSessionIds?.() || [];
      if (!sessions.length) return null;

      const isNonWatchSession = (sessionId: string) => {
        const s = sessionId.toLowerCase();
        return s.includes('billboard') || s.includes('preview-modal') || s.includes('merch');
      };

      // 1. Preferred: Non-ad player session matching current URL
      if (currentUrlMovieId) {
        for (let i = sessions.length - 1; i >= 0; i--) {
          const sId = sessions[i];
          if (isNonWatchSession(sId)) continue;
          const p = vp.getVideoPlayerBySessionId(sId);
          if (p && !p.isAd?.() && String(p.getMovieId?.()) === currentUrlMovieId) {
            return { player: p, sessionId: sId };
          }
        }
      }

      // 2. Secondary: Any non-ad watch session actively playing
      for (let i = sessions.length - 1; i >= 0; i--) {
        const sId = sessions[i];
        if (isNonWatchSession(sId)) continue;
        const p = vp.getVideoPlayerBySessionId(sId);
        if (p && !p.isAd?.()) {
          const isPlaying = typeof p.isPlaying === 'function' ? p.isPlaying() : !p.isPaused?.();
          if (isPlaying) {
            return { player: p, sessionId: sId };
          }
        }
      }

      // 3. Fallback: Most recent non-ad watch session
      for (let i = sessions.length - 1; i >= 0; i--) {
        const sId = sessions[i];
        if (isNonWatchSession(sId)) continue;
        const p = vp.getVideoPlayerBySessionId(sId);
        if (p && !p.isAd?.()) {
          return { player: p, sessionId: sId };
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  getActiveMovieId(): string | null {
    try {
      const active = this.getActivePlayer();
      if (active?.player && typeof active.player.getMovieId === 'function') {
        const mid = active.player.getMovieId();
        if (mid) return String(mid);
      }
      return this.extractVideoId(window.location.href);
    } catch {
      return this.extractVideoId(window.location.href);
    }
  }

  checkKadmiumPlayerState(): void {
    try {
      const active = this.getActivePlayer();
      if (!active || !active.player) {
        if (!this.extractVideoId(window.location.href)) {
          this.lastObservedMovieId = null;
          this.lastReportedSegmentTime = null;
        }
        return;
      }
      const { player, sessionId } = active;

      const vp = window.netflix?.appContext?.state?.playerApp?.getAPI()?.videoPlayer;
      const sessions = vp?.getAllPlayerSessionIds?.() || [];

      // 1. Authoritative Ad State Check across player sessions
      let isAd = false;
      for (let i = 0; i < sessions.length; i++) {
        const p = vp.getVideoPlayerBySessionId(sessions[i]);
        if (p?.isAd?.()) {
          isAd = true;
          break;
        }
      }
      if (!isAd && typeof player.isAd === 'function') {
        isAd = Boolean(player.isAd());
      }

      if (isAd !== this.lastAdState) {
        this.lastAdState = isAd;
        this.logger.info('PlayerBridge', `Kadmium isAd changed: ${isAd}`);
        this.onAdStateChangeHandler?.(isAd);
      }

      if (isAd) return;

      // 2. Authoritative Episode / Movie Change Check
      const movieId = typeof player.getMovieId === 'function' ? player.getMovieId() : null;
      if (movieId && this.lastObservedMovieId !== null && movieId !== this.lastObservedMovieId) {
        const midStr = String(movieId);
        this.logger.info(
          'PlayerBridge',
          `Episode change detected via Kadmium API: ${this.lastObservedMovieId} -> ${movieId}`
        );
        this.lastObservedMovieId = movieId;
        this.lastReportedSegmentTime = null;

        if (document.documentElement) {
          delete document.documentElement.dataset.ncwSegmentAtomic;
          delete document.documentElement.dataset.ncwSegmentTime;
          delete document.documentElement.dataset.ncwSegmentSyncAt;
          delete document.documentElement.dataset.ncwIsPaused;
          delete document.documentElement.dataset.ncwPlaybackRate;
          delete document.documentElement.dataset.ncwCadmiumOffset;
          delete document.documentElement.dataset.ncwAdOffset;
          delete document.documentElement.dataset.ncwKadmiumTime;
          delete document.documentElement.dataset.ncwTimeSyncAt;
        }

        this.onEpisodeChangeHandler?.(midStr, sessionId, window.location.href);
      } else if (movieId && this.lastObservedMovieId === null) {
        this.lastObservedMovieId = movieId;
      }

      // 2.1 Sync video metadata (title, show summary, episode summary) from player session / falcor cache
      if (movieId && document.documentElement) {
        try {
          const midStr = String(movieId);
          const falcor = window.netflix?.falcorCache?.videos;
          const currentVideoObj = falcor?.[midStr];

          let epSummary = '';
          let shSummary = '';
          let shTitle = '';
          let epTitle = '';

          if (currentVideoObj) {
            epSummary =
              currentVideoObj.synopsis?.value || currentVideoObj.regularSynopsis?.value || '';
            epTitle = currentVideoObj.title?.value || '';

            // Check ancestor/show summary if this is an episode
            const showRef = currentVideoObj.ancestor?.value || currentVideoObj.show?.value;
            const showId = Array.isArray(showRef)
              ? showRef[1]
              : typeof showRef === 'string'
                ? showRef
                : null;
            if (showId && falcor[showId]) {
              const showObj = falcor[showId];
              shSummary = showObj.synopsis?.value || showObj.regularSynopsis?.value || '';
              shTitle = showObj.title?.value || '';
            } else if (!showId) {
              // May be a standalone movie
              shSummary = epSummary;
              shTitle = epTitle;
            }
          }

          if (shSummary) document.documentElement.dataset.ncwShowSummary = shSummary;
          if (epSummary) document.documentElement.dataset.ncwEpisodeSummary = epSummary;
          if (shTitle) document.documentElement.dataset.ncwMainTitle = shTitle;
          if (epTitle) document.documentElement.dataset.ncwEpisodeTitle = epTitle;
        } catch {
          // Ignore falcor inspection errors
        }
      }

      // 2.2 Subtitle Text Track Check (bound to active player session)
      if (!this.isProbingNativeTrack) {
        const currentTrack = this.getCurrentTimedTextTrack(player);
        const isOff = this.isTimedTextTrackOff(currentTrack);
        const trackSig = this.getTimedTextTrackSignature(currentTrack);

        const lastSessionTrack = this.lastTrackBySession.get(sessionId);
        if (!lastSessionTrack) {
          this.lastTrackBySession.set(sessionId, { trackId: trackSig, isOff });
          if (isOff) {
            this.logger.info(
              'PlayerBridge',
              `Session ${sessionId} initialized with subtitle OFF.`
            );
            this.onSubtitleTrackChangeHandler?.(null, sessionId, true);
          }
        } else if (lastSessionTrack.trackId !== trackSig || lastSessionTrack.isOff !== isOff) {
          this.logger.info(
            'PlayerBridge',
            `Subtitle track changed for session ${sessionId}: "${lastSessionTrack.trackId}" -> "${trackSig}" (isOff: ${isOff})`
          );
          this.lastTrackBySession.set(sessionId, { trackId: trackSig, isOff });
          this.onSubtitleTrackChangeHandler?.(currentTrack, sessionId, isOff);
        }
      }

      // 3. Segment Time Tracking
      let playerTimeMs: number | null = null;
      let timeSource = 'none';

      if (typeof player.getSegmentTime === 'function') {
        try {
          let seg = player.getSegmentTime();
          if (typeof seg === 'number' && !isNaN(seg) && seg >= 0) {
            playerTimeMs = seg;
            timeSource = 'player.getSegmentTime()';
          } else {
            const cur = typeof player.getCurrentTime === 'function' ? player.getCurrentTime() : 0;
            seg = player.getSegmentTime(cur);
            if (typeof seg === 'number' && !isNaN(seg) && seg >= 0) {
              playerTimeMs = seg;
              timeSource = 'player.getSegmentTime(cur)';
            }
          }
        } catch {
          try {
            const cur = typeof player.getCurrentTime === 'function' ? player.getCurrentTime() : 0;
            const seg = player.getSegmentTime(cur);
            if (typeof seg === 'number' && !isNaN(seg) && seg >= 0) {
              playerTimeMs = seg;
              timeSource = 'player.getSegmentTime(cur)';
            }
          } catch {}
        }
      }

      if (playerTimeMs === null && typeof vp?.getSegmentTime === 'function') {
        try {
          let seg = vp.getSegmentTime(sessionId);
          if (typeof seg !== 'number' || isNaN(seg) || seg < 0) {
            seg = vp.getSegmentTime();
          }
          if (typeof seg === 'number' && !isNaN(seg) && seg >= 0) {
            playerTimeMs = seg;
            timeSource = 'vp.getSegmentTime(session)';
          }
        } catch {}
      }

      if (playerTimeMs === null && typeof player.getCurrentTime === 'function') {
        const cur = player.getCurrentTime();
        if (typeof cur === 'number' && !isNaN(cur) && cur >= 0) {
          playerTimeMs = cur;
          timeSource = 'player.getCurrentTime()';
        }
      }

      if (playerTimeMs !== null) {
        const v = document.querySelector('video');
        const videoSec = v && typeof v.currentTime === 'number' ? v.currentTime : 0;
        let targetSec = playerTimeMs / 1000;
        if (
          v &&
          Math.abs(playerTimeMs - videoSec) < Math.abs(targetSec - videoSec) &&
          playerTimeMs < (v.duration || 86400)
        ) {
          targetSec = playerTimeMs;
        }

        const isPaused = v ? v.paused : false;
        const playbackRate = v ? v.playbackRate || 1.0 : 1.0;
        const nowPerf = performance.now();

        if (document.documentElement) {
          document.documentElement.dataset.ncwSegmentAtomic = `${targetSec}|${nowPerf}|${isPaused ? 1 : 0}|${playbackRate}`;
          document.documentElement.dataset.ncwSegmentTime = String(targetSec);
          document.documentElement.dataset.ncwSegmentSyncAt = String(nowPerf);
          document.documentElement.dataset.ncwIsPaused = isPaused ? 'true' : 'false';
          document.documentElement.dataset.ncwPlaybackRate = String(playbackRate);

          document.documentElement.dataset.ncwCadmiumOffset = '0';
          document.documentElement.dataset.ncwAdOffset = '0';
          document.documentElement.dataset.ncwKadmiumTime = String(targetSec);
          document.documentElement.dataset.ncwTimeSyncAt = String(Date.now());
        }

        if (
          this.lastReportedSegmentTime === null ||
          Math.abs(targetSec - this.lastReportedSegmentTime) > 0.5
        ) {
          this.lastReportedSegmentTime = targetSec;
          this.onTimeSyncHandler?.({
            segmentTime: targetSec,
            syncAt: nowPerf,
            isPaused,
            playbackRate,
            cadmiumOffset: 0,
            adOffset: 0,
            source: timeSource,
          });
        }
      }
    } catch {
      // Ignore
    }
  }

  setProbingNativeTrack(isProbing: boolean): void {
    this.isProbingNativeTrack = isProbing;
    if (!isProbing) {
      const active = this.getActivePlayer();
      if (active && active.player && active.sessionId) {
        const currentTrack = this.getCurrentTimedTextTrack(active.player);
        const isOff = this.isTimedTextTrackOff(currentTrack);
        const trackSig = this.getTimedTextTrackSignature(currentTrack);
        this.lastTrackBySession.set(active.sessionId, { trackId: trackSig, isOff });
      }
    }
  }

  getCurrentTimedTextTrack(player: any): any {
    if (!player) return null;
    const internalP =
      typeof player.getInternalPlayer === 'function' ? player.getInternalPlayer() : null;
    if (typeof internalP?.getTextTrack === 'function') {
      try {
        const t = internalP.getTextTrack();
        if (t) return t;
      } catch {}
    }
    if (typeof player.getTimedTextTrack === 'function') {
      try {
        const t = player.getTimedTextTrack();
        if (t) return t;
      } catch {}
    }
    const segTrack = internalP?.playback?.currentSegment?.tracks?.timedTextTrack;
    if (segTrack) return segTrack;
    return null;
  }

  isTimedTextTrackOff(track: any): boolean {
    if (!track) return true;
    if (track.isNone) return true;
    if (track.trackType === 'OFF' || track.trackType === 'NONE') return true;
    const bcp = (track.bcp47 || track.language || track.lang || '').toLowerCase().trim();
    if (bcp === 'none' || bcp === 'off') return true;
    return false;
  }

  getTimedTextTrackSignature(track: any): string {
    if (this.isTimedTextTrackOff(track)) return '__OFF__';
    const id = track.trackId || track.id || track.newTrackId || '';
    const bcp = (track.bcp47 || track.language || track.lang || '').toLowerCase().trim();
    const type = track.trackType || '';
    return `${id}|${bcp}|${type}` || '__ON__';
  }

  fetchSubtitleFromPlayerApi(
    onSubtitleLoaded: (
      trackUrl: string,
      text: string,
      movieId: string,
      bcp47?: string | null
    ) => void,
    force = false,
    retryCount = 0,
    explicitTrack?: any
  ): void {
    try {
      const vp = window.netflix?.appContext?.state?.playerApp?.getAPI()?.videoPlayer;
      if (!vp) {
        this.logger.warn('PlayerBridge', 'videoPlayer API not found on window.netflix');
        return;
      }
      const sessions = vp.getAllPlayerSessionIds?.() || [];
      const currentUrlMovieId = this.extractVideoId(window.location.href);

      let targetPlayer: any = null;
      let targetSessionId: string | null = null;

      if (currentUrlMovieId) {
        for (let i = sessions.length - 1; i >= 0; i--) {
          const p = vp.getVideoPlayerBySessionId(sessions[i]);
          if (p && !p.isAd?.() && String(p.getMovieId?.()) === currentUrlMovieId) {
            targetPlayer = p;
            targetSessionId = sessions[i];
            break;
          }
        }
      }

      if (!targetPlayer) {
        const active = this.getActivePlayer();
        targetPlayer = active?.player;
        targetSessionId = active?.sessionId || null;
      }

      if (!targetPlayer) {
        if (force && retryCount < 5) {
          setTimeout(
            () =>
              this.fetchSubtitleFromPlayerApi(
                onSubtitleLoaded,
                force,
                retryCount + 1,
                explicitTrack
              ),
            600
          );
        }
        return;
      }

      const movieId = String(targetPlayer.getMovieId?.() || currentUrlMovieId || '');
      this.logger.info(
        'PlayerBridge',
        `Querying subtitle track for movieId: ${movieId} in session: ${targetSessionId}`
      );

      let currentTrack = explicitTrack || this.getCurrentTimedTextTrack(targetPlayer);
      if (!currentTrack || this.isTimedTextTrackOff(currentTrack)) {
        if (force && retryCount < 5) {
          setTimeout(
            () =>
              this.fetchSubtitleFromPlayerApi(
                onSubtitleLoaded,
                force,
                retryCount + 1,
                explicitTrack
              ),
            700
          );
        }
        return;
      }

      const internalP =
        typeof targetPlayer.getInternalPlayer === 'function'
          ? targetPlayer.getInternalPlayer()
          : null;

      // 1. Check getPlayerTextTracks() from internal player
      const playerTextTracks: any[] =
        typeof internalP?.getPlayerTextTracks === 'function'
          ? internalP.getPlayerTextTracks() || []
          : [];

      const currentTrackId = currentTrack.trackId || currentTrack.id;
      const currentBcp = (currentTrack.bcp47 || currentTrack.language || '').toLowerCase().trim();

      // Find matching player text track
      let matchedPlayerTrack = playerTextTracks.find((pt: any) => {
        if (!pt) return false;
        if (currentTrackId && (pt.trackId === currentTrackId || pt.id === currentTrackId)) return true;
        const ptBcp = (pt.bcp47 || pt.language || '').toLowerCase().trim();
        return currentBcp && ptBcp === currentBcp;
      });

      const effectiveBcp =
        matchedPlayerTrack?.bcp47 ||
        matchedPlayerTrack?.language ||
        currentTrack.bcp47 ||
        currentTrack.language ||
        null;

      // 1.1 Direct resolve from downloadPromise if available
      if (matchedPlayerTrack?.downloadPromise) {
        Promise.resolve(matchedPlayerTrack.downloadPromise)
          .then((text: any) => {
            if (typeof text === 'string' && text.length > 50) {
              const url =
                Array.isArray(matchedPlayerTrack.urls) && matchedPlayerTrack.urls[0]?.url
                  ? matchedPlayerTrack.urls[0].url
                  : 'player://internalP.getPlayerTextTracks/downloadPromise';
              this.logger.info(
                'PlayerBridge',
                `Subtitles resolved directly from playerTextTrack.downloadPromise for ${effectiveBcp} (${text.length} chars).`
              );
              onSubtitleLoaded(url, text, movieId, effectiveBcp);
              return;
            }
            throw new Error('Empty downloadPromise result');
          })
          .catch(() => {
            // Fallback to URL fetch below
            this.fetchSubtitleByUrls(
              matchedPlayerTrack || currentTrack,
              targetPlayer,
              movieId,
              effectiveBcp,
              onSubtitleLoaded,
              force,
              retryCount
            );
          });
        return;
      }

      this.fetchSubtitleByUrls(
        matchedPlayerTrack || currentTrack,
        targetPlayer,
        movieId,
        effectiveBcp,
        onSubtitleLoaded,
        force,
        retryCount
      );
    } catch (e) {
      this.logger.warn('PlayerBridge', 'Exception in fetchSubtitleFromPlayerApi:', e);
    }
  }

  private fetchSubtitleByUrls(
    trackObj: any,
    targetPlayer: any,
    movieId: string,
    bcp47: string | null,
    onSubtitleLoaded: (trackUrl: string, text: string, movieId: string, bcp47?: string | null) => void,
    force: boolean,
    retryCount: number
  ): void {
    let trackUrl: string | null = null;
    let urls = this.extractUrlsFromDownloadableEntry(trackObj);
    if (urls.length > 0) {
      trackUrl = urls[0];
    }

    if (!trackUrl && typeof targetPlayer.getTimedTextTrackList === 'function') {
      const trackList = targetPlayer.getTimedTextTrackList() || [];
      const trackId = trackObj.trackId || trackObj.id;
      const bcp = (bcp47 || trackObj.bcp47 || trackObj.language || '').toLowerCase();
      const matched = trackList.find(
        (t: any) =>
          (trackId && (t.trackId === trackId || t.id === trackId)) ||
          (bcp && (t.bcp47 || t.language || '').toLowerCase() === bcp)
      );
      if (matched) {
        urls = this.extractUrlsFromDownloadableEntry(matched);
        if (urls.length > 0) {
          trackUrl = urls[0];
        }
      }
    }

    if (trackUrl) {
      window
        .fetch(trackUrl)
        .then((r) => r.text())
        .then((text) => {
          onSubtitleLoaded(trackUrl!, text, movieId, bcp47);
        })
        .catch((err) => {
          this.logger.warn(
            '[PlayerBridge] [Player-API] Failed to fetch track from player API:',
            err
          );
        });
    } else if (force && retryCount < 5) {
      setTimeout(
        () =>
          this.fetchSubtitleFromPlayerApi(onSubtitleLoaded, force, retryCount + 1, trackObj),
        800
      );
    }
  }

  extractUrlsFromDownloadableEntry(entry: any): string[] {
    if (!entry) return [];
    const results: string[] = [];

    const isHttpUrl = (str: string): boolean => {
      try {
        const u = new URL(str);
        return u.protocol === 'http:' || u.protocol === 'https:';
      } catch {
        return false;
      }
    };

    const extract = (val: any, depth = 0) => {
      if (!val || depth > 5) return;
      if (typeof val === 'string') {
        if (isHttpUrl(val)) {
          results.push(val);
        }
        return;
      }
      if (typeof val === 'object') {
        if (typeof val.url === 'string' && isHttpUrl(val.url)) {
          results.push(val.url);
        }
        if (Array.isArray(val)) {
          for (const item of val) {
            extract(item, depth + 1);
          }
        } else {
          if (val.urls) extract(val.urls, depth + 1);
          if (val.downloadUrls) extract(val.downloadUrls, depth + 1);
          if (val.cdnlist) extract(val.cdnlist, depth + 1);
          for (const key of Object.keys(val)) {
            if (
              key !== 'urls' &&
              key !== 'downloadUrls' &&
              key !== 'cdnlist' &&
              key !== 'url' &&
              key !== 'log' &&
              key !== 'logFields' &&
              key !== 'publicInterface' &&
              key !== 'playback' &&
              key !== 'subsManager' &&
              key !== 'trackContext'
            ) {
              extract(val[key], depth + 1);
            }
          }
        }
      }
    };

    extract(entry);
    return Array.from(new Set(results));
  }

  fetchNativeTrackByLanguage(
    _movieId: string,
    targetLanguageCode: string,
    onResult: (res: { found: boolean; rawText?: string; bcp47?: string; error?: string }) => void
  ): void {
    try {
      const active = this.getActivePlayer();
      const targetPlayer = active?.player;
      if (!targetPlayer) {
        onResult({ found: false, error: 'No active player session' });
        return;
      }

      // 1. Get timed text tracks list from player
      let trackList: any[] = [];
      if (typeof targetPlayer.getTimedTextTrackList === 'function') {
        trackList = targetPlayer.getTimedTextTrackList() || [];
      } else {
        const vp = window.netflix?.appContext?.state?.playerApp?.getAPI()?.videoPlayer;
        const sessionId = active?.sessionId;
        const p = sessionId && vp?.getVideoPlayerBySessionId?.(sessionId);
        if (p && typeof p.getTimedTextTrackList === 'function') {
          trackList = p.getTimedTextTrackList() || [];
        }
      }

      if (!trackList || trackList.length === 0) {
        // Fallback to internal player tracks
        const internalTracks = targetPlayer.getInternalPlayer?.()?.playback?.timedTextTracks || [];
        trackList = Array.isArray(internalTracks) ? internalTracks : [];
      }

      this.logger.info(
        'PlayerBridge',
        `fetchNativeTrackByLanguage: candidate tracks count = ${trackList.length}, targetLang = ${targetLanguageCode}`
      );

      // 2. Find matching track by bcp47 or language
      const cleanTarget = targetLanguageCode.trim().toLowerCase();
      const matchedTrack = trackList.find((t) => {
        if (!t || t.isNone) return false;
        const bcp = (t.bcp47 || t.language || '').toLowerCase();
        if (!bcp) return false;

        // Direct match
        if (bcp === cleanTarget) return true;

        // Chinese specific matching
        if (cleanTarget === 'zh-cn' || cleanTarget === 'zh') {
          return bcp === 'zh-hans' || bcp === 'zh-cn' || bcp === 'zh';
        }
        if (cleanTarget === 'zh-tw' || cleanTarget === 'zh-hk') {
          return bcp === 'zh-hant' || bcp === 'zh-tw' || bcp === 'zh-hk';
        }

        // Prefix match e.g. 'en-US' matches 'en'
        if (cleanTarget.startsWith(bcp) || bcp.startsWith(cleanTarget)) {
          return true;
        }

        return false;
      });

      if (!matchedTrack) {
        this.logger.info(
          'PlayerBridge',
          `No native track matching ${targetLanguageCode} among available tracks.`
        );
        onResult({ found: false });
        return;
      }

      // 3. Check if track already exists in internalP.getPlayerTextTracks() with downloadPromise or urls
      const internalP =
        typeof targetPlayer.getInternalPlayer === 'function'
          ? targetPlayer.getInternalPlayer()
          : null;
      const playerTextTracks: any[] =
        typeof internalP?.getPlayerTextTracks === 'function'
          ? internalP.getPlayerTextTracks() || []
          : [];

      const matchedId = matchedTrack.trackId || matchedTrack.id;
      const matchedBcp = (matchedTrack.bcp47 || matchedTrack.language || '').toLowerCase().trim();
      const existingPlayerTrack = playerTextTracks.find((pt: any) => {
        if (!pt) return false;
        if (matchedId && (pt.trackId === matchedId || pt.id === matchedId)) return true;
        const ptBcp = (pt.bcp47 || pt.language || '').toLowerCase().trim();
        return matchedBcp && ptBcp === matchedBcp;
      });

      if (existingPlayerTrack?.downloadPromise) {
        Promise.resolve(existingPlayerTrack.downloadPromise)
          .then((rawText: any) => {
            if (typeof rawText === 'string' && rawText.length > 50) {
              this.logger.info(
                'PlayerBridge',
                `Native track content for ${matchedTrack.bcp47} retrieved from playerTextTrack.downloadPromise.`
              );
              onResult({
                found: true,
                rawText,
                bcp47: matchedTrack.bcp47 || matchedTrack.language,
              });
              return;
            }
            throw new Error('Empty downloadPromise');
          })
          .catch(() => {
            // Fall through to URL fetch
          });
      }

      // 4. Extract download URL
      let trackUrl: string | null = null;
      const urls = this.extractUrlsFromDownloadableEntry(existingPlayerTrack || matchedTrack);
      if (urls.length > 0) {
        trackUrl = urls[0];
      }

      if (!trackUrl) {
        this.logger.warn(
          'PlayerBridge',
          `Found track ${matchedTrack.bcp47} but could not extract downloadable URL.`
        );
        onResult({ found: false, error: 'Could not extract download URL' });
        return;
      }

      this.logger.info(
        'PlayerBridge',
        `Fetching native track content for ${matchedTrack.bcp47} from URL...`
      );

      window
        .fetch(trackUrl)
        .then((r) => r.text())
        .then((rawText) => {
          onResult({
            found: true,
            rawText,
            bcp47: matchedTrack.bcp47 || matchedTrack.language,
          });
        })
        .catch((err) => {
          this.logger.warn('PlayerBridge', 'Failed to fetch native track from URL:', err);
          onResult({ found: false, error: String(err) });
        });
    } catch (err: any) {
      this.logger.warn('PlayerBridge', 'Exception in fetchNativeTrackByLanguage:', err);
      onResult({ found: false, error: err?.message || String(err) });
    }
  }
}
