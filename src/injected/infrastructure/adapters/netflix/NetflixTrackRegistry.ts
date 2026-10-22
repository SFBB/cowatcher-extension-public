import {
  KnownTrackDetail,
  UnknownTrackDetail,
  NetflixPlayerTextTrack,
  NetflixTimedTextTrack,
} from './NetflixTypes';
import { NetflixPlayerBridge } from './NetflixPlayerBridge';
import { NetflixMetadataManager } from './NetflixMetadataManager';
import { Logger } from '@shared/utils/logger';

export class NetflixTrackRegistry {
  private readonly logger = new Logger('NetflixTrackRegistry');

  // Three-level table: showId -> epId -> lang (bcp47 lowercase) -> KnownTrackDetail
  private readonly knownTracks = new Map<
    string,
    Map<string, Map<string, KnownTrackDetail>>
  >();

  // Unknown intercepted tracks: url -> UnknownTrackDetail
  private readonly unknownTracks = new Map<string, UnknownTrackDetail>();

  // Fast reverse index for O(1) lookup: exact url -> KnownTrackDetail
  private readonly urlToKnownTrackIndex = new Map<string, KnownTrackDetail>();

  // Deferred resolvers waiting for a specific track to be activated and loaded
  private activeActivationWaiter: {
    targetBcp47: string;
    resolve: (detail: KnownTrackDetail) => void;
    reject: (error: Error) => void;
  } | null = null;

  constructor(
    private readonly playerBridge: NetflixPlayerBridge,
    private readonly metadataManager: NetflixMetadataManager,
  ) {}

  // --------------------------------------------------------------------------
  // 1. Interception Handlers
  // --------------------------------------------------------------------------

  addUnknownInterceptedTrack(url: string, rawText: string): UnknownTrackDetail {
    const unknownDetail: UnknownTrackDetail = {
      url,
      rawText,
      interceptedAt: Date.now(),
    };
    this.unknownTracks.set(url, unknownDetail);
    this.logger.info('Netflix', `Stored unknown intercepted track: ${url.slice(0, 80)}`);
    return unknownDetail;
  }

  addInterceptedTrack(url: string, rawText: string): KnownTrackDetail | null {
    const existing = this.urlToKnownTrackIndex.get(url);
    if (existing) {
      return this.updateKnownTrackText(existing, rawText);
    }

    const currentEpisodeId = this.playerBridge.getCurrentMovieId();
    if (!currentEpisodeId) {
      this.addUnknownInterceptedTrack(url, rawText);
      return null;
    }

    const matchedPlayerTrack = this.findPlayerTrackByUrl(url);
    if (!matchedPlayerTrack || !matchedPlayerTrack.bcp47) {
      this.addUnknownInterceptedTrack(url, rawText);
      return null;
    }

    const showId = this.metadataManager.getShowId(currentEpisodeId);
    const lang = matchedPlayerTrack.bcp47.toLowerCase();
    const urls = matchedPlayerTrack.urls.map((u) => u.url);

    const knownDetail = this.registerKnownTrack(showId, currentEpisodeId, lang, {
      trackId: matchedPlayerTrack.trackId,
      displayName: matchedPlayerTrack.displayName,
      trackType: matchedPlayerTrack.trackType,
      urls,
      rawText,
      interceptedAt: Date.now(),
    });

    this.resolveActivationWaiterIfMatches(knownDetail);
    return knownDetail;
  }

  // --------------------------------------------------------------------------
  // 2. Query Track & On-Demand Acquisition
  // --------------------------------------------------------------------------

  async getTrack(
    showId: string,
    epId: string,
    lang: string,
  ): Promise<KnownTrackDetail | null> {
    const normalizedLang = lang.toLowerCase();

    const cached = this.getCachedTrack(showId, epId, normalizedLang);
    if (cached) {
      return cached;
    }

    const proactivelyFetched = await this.tryProactiveFetch(
      showId,
      epId,
      normalizedLang,
    );
    if (proactivelyFetched) {
      return proactivelyFetched;
    }

    return this.probeTrackViaActivation(showId, epId, normalizedLang);
  }

  // --------------------------------------------------------------------------
  // 3. Unknown Track Re-identification on Episode Change
  // --------------------------------------------------------------------------

  checkUnknownTracks(
    showId: string,
    epId: string,
  ): readonly KnownTrackDetail[] {
    const resolved: KnownTrackDetail[] = [];
    const playerTracks = this.playerBridge.getPlayerTextTracks();

    for (const [url, unknownTrack] of this.unknownTracks.entries()) {
      const matched = playerTracks.find(
        (pt) => pt.bcp47 && pt.urls.some((u) => u.url === url),
      );
      if (matched && matched.bcp47) {
        const lang = matched.bcp47.toLowerCase();
        const urls = matched.urls.map((u) => u.url);

        const known = this.registerKnownTrack(showId, epId, lang, {
          trackId: matched.trackId,
          displayName: matched.displayName,
          trackType: matched.trackType,
          urls,
          rawText: unknownTrack.rawText,
          interceptedAt: unknownTrack.interceptedAt,
        });

        this.unknownTracks.delete(url);
        resolved.push(known);
        this.logger.info(
          'Netflix',
          `Unknown track identified for ep ${epId} (${lang}): ${url.slice(0, 80)}`,
        );
      }
    }

    return resolved;
  }

  // --------------------------------------------------------------------------
  // 4. Unified Internal Known Track Registration Method
  // --------------------------------------------------------------------------

  registerKnownTrack(
    showId: string,
    episodeId: string,
    lang: string,
    data: Omit<KnownTrackDetail, 'showId' | 'episodeId' | 'lang'>,
  ): KnownTrackDetail {
    let epMap = this.knownTracks.get(showId);
    if (!epMap) {
      epMap = new Map();
      this.knownTracks.set(showId, epMap);
    }

    let langMap = epMap.get(episodeId);
    if (!langMap) {
      langMap = new Map();
      epMap.set(episodeId, langMap);
    }

    const detail: KnownTrackDetail = {
      showId,
      episodeId,
      lang,
      trackId: data.trackId,
      displayName: data.displayName,
      trackType: data.trackType,
      urls: data.urls,
      rawText: data.rawText,
      interceptedAt: data.interceptedAt,
    };

    langMap.set(lang, detail);

    for (const url of detail.urls) {
      this.urlToKnownTrackIndex.set(url, detail);
    }

    return detail;
  }

  // --------------------------------------------------------------------------
  // 5. Modular Helper Methods (Under 50 Lines)
  // --------------------------------------------------------------------------

  private getCachedTrack(
    showId: string,
    epId: string,
    normalizedLang: string,
  ): KnownTrackDetail | null {
    const epMap = this.knownTracks.get(showId);
    if (!epMap) return null;
    const langMap = epMap.get(epId);
    if (!langMap) return null;
    return langMap.get(normalizedLang) || null;
  }

  private findPlayerTrackByUrl(url: string): NetflixPlayerTextTrack | null {
    const playerTracks = this.playerBridge.getPlayerTextTracks();
    for (const pt of playerTracks) {
      if (pt.urls.some((u) => u.url === url)) {
        return pt;
      }
    }
    return null;
  }

  private updateKnownTrackText(
    existing: KnownTrackDetail,
    rawText: string,
  ): KnownTrackDetail {
    return this.registerKnownTrack(
      existing.showId,
      existing.episodeId,
      existing.lang,
      {
        trackId: existing.trackId,
        displayName: existing.displayName,
        trackType: existing.trackType,
        urls: existing.urls,
        rawText,
        interceptedAt: Date.now(),
      },
    );
  }

  private async tryProactiveFetch(
    showId: string,
    epId: string,
    normalizedLang: string,
  ): Promise<KnownTrackDetail | null> {
    const playerTracks = this.playerBridge.getPlayerTextTracks();
    const candidate = playerTracks.find(
      (pt) =>
        pt.bcp47 &&
        pt.bcp47.toLowerCase() === normalizedLang &&
        pt.urls.length > 0,
    );

    if (!candidate || !candidate.bcp47) {
      return null;
    }

    const url = candidate.urls[0].url;
    try {
      const response = await window.fetch(url);
      if (!response.ok) return null;
      const rawText = await response.text();
      if (!rawText || rawText.length < 50) return null;

      const urls = candidate.urls.map((u) => u.url);
      return this.registerKnownTrack(showId, epId, normalizedLang, {
        trackId: candidate.trackId,
        displayName: candidate.displayName,
        trackType: candidate.trackType,
        urls,
        rawText,
        interceptedAt: Date.now(),
      });
    } catch (err) {
      this.logger.warn('Netflix', 'Proactive track fetch failed:', err);
      return null;
    }
  }

  private async probeTrackViaActivation(
    showId: string,
    epId: string,
    normalizedLang: string,
  ): Promise<KnownTrackDetail | null> {
    const availableTracks = this.playerBridge.getAvailableTextTracks();
    const targetTrack = availableTracks.find(
      (t) => t.bcp47 && t.bcp47.toLowerCase() === normalizedLang,
    );

    if (!targetTrack || !targetTrack.bcp47) {
      return null;
    }

    const originalTrack = this.playerBridge.getActiveTextTrack();

    try {
      const detail = await this.executeTrackActivationSwitch(
        showId,
        epId,
        targetTrack,
        targetTrack.bcp47.toLowerCase(),
      );
      this.restoreOriginalTrack(originalTrack);
      return detail;
    } catch (err) {
      this.restoreOriginalTrack(originalTrack);
      this.logger.warn('Netflix', 'Track activation probe failed:', err);
      return null;
    }
  }

  private executeTrackActivationSwitch(
    showId: string,
    epId: string,
    targetTrack: NetflixTimedTextTrack,
    targetBcp47: string,
  ): Promise<KnownTrackDetail> {
    return new Promise<KnownTrackDetail>((resolve, reject) => {
      const timeout = setTimeout(async () => {
        if (!this.activeActivationWaiter) return;
        this.activeActivationWaiter = null;

        // Check if playerTextTracks now has the populated URL
        const playerTracks = this.playerBridge.getPlayerTextTracks();
        const active = playerTracks.find(
          (pt) => pt.trackId === targetTrack.trackId && pt.urls.length > 0,
        );
        if (active && active.urls.length > 0) {
          try {
            const res = await window.fetch(active.urls[0].url);
            if (res.ok) {
              const rawText = await res.text();
              const urls = active.urls.map((u) => u.url);
              const detail = this.registerKnownTrack(showId, epId, targetBcp47, {
                trackId: targetTrack.trackId,
                displayName: targetTrack.displayName,
                trackType: targetTrack.trackType,
                urls,
                rawText,
                interceptedAt: Date.now(),
              });
              resolve(detail);
              return;
            }
          } catch {}
        }
        reject(new Error(`Activation timed out for ${targetBcp47}`));
      }, 2500);

      this.activeActivationWaiter = {
        targetBcp47,
        resolve: (detail) => {
          clearTimeout(timeout);
          resolve(detail);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      };

      this.playerBridge.setTextTrack(targetTrack);
    });
  }

  private restoreOriginalTrack(
    originalTrack: NetflixTimedTextTrack | null,
  ): void {
    if (originalTrack) {
      this.playerBridge.setTextTrack(originalTrack);
    }
  }

  private resolveActivationWaiterIfMatches(detail: KnownTrackDetail): void {
    if (
      this.activeActivationWaiter &&
      this.activeActivationWaiter.targetBcp47 === detail.lang
    ) {
      const waiter = this.activeActivationWaiter;
      this.activeActivationWaiter = null;
      waiter.resolve(detail);
    }
  }
}
