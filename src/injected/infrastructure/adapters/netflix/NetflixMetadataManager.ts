import {
  NetflixMetadataApiResponse,
  NetflixVideoMetadata,
  NetflixSeasonMetadata,
  NetflixEpisodeMetadata,
} from './NetflixTypes';
import { InjectedMetadataLoadedPayload } from '../../../domain/IInjectedAdapter';
import { NCW_MESSAGE_TYPES } from '@shared/domain/constants/MessageTypes';
import { Logger } from '@shared/utils/logger';

export class NetflixMetadataManager {
  private readonly logger = new Logger('NetflixMetadataManager');

  private cachedShowMetadata: NetflixVideoMetadata | null = null;
  private readonly episodeToShowIdMap = new Map<string, string>();

  getShowId(episodeId: string): string {
    const mapped = this.episodeToShowIdMap.get(episodeId);
    if (mapped) return mapped;
    if (this.cachedShowMetadata) {
      return String(this.cachedShowMetadata.id);
    }
    return episodeId;
  }

  isEpisodeCached(episodeId: string): boolean {
    return this.episodeToShowIdMap.has(episodeId);
  }

  getCachedMetadata(): NetflixVideoMetadata | null {
    return this.cachedShowMetadata;
  }

  async fetchMetadata(episodeId: string): Promise<NetflixVideoMetadata | null> {
    if (!episodeId) return null;

    const url = `/nq/website/memberapi/release/metadata?isVolatileBillboardsEnabled=true&movieid=${episodeId}&imageFormat=webp&withSize=true&materialize=true&_=${Date.now()}`;
    try {
      const response = await window.fetch(url, {
        credentials: 'include',
        headers: { Accept: 'application/json, text/plain, */*' },
      });
      if (!response.ok) return null;
      const data: NetflixMetadataApiResponse = await response.json();
      return this.handleMetadataApiResponse(data);
    } catch (err) {
      this.logger.warn('Netflix', `Failed to fetch metadata for ${episodeId}:`, err);
      return null;
    }
  }

  handleMetadataApiResponse(
    data: NetflixMetadataApiResponse,
  ): NetflixVideoMetadata | null {
    const video = data.video;
    if (!video || !video.id) return null;

    this.cachedShowMetadata = video;
    const showId = String(video.id);

    if (Array.isArray(video.seasons)) {
      for (const season of video.seasons) {
        for (const ep of season.episodes) {
          this.episodeToShowIdMap.set(String(ep.id), showId);
        }
      }
    } else {
      this.episodeToShowIdMap.set(showId, showId);
    }

    return video;
  }

  buildMetadataPayload(
    targetEpisodeId: string,
  ): InjectedMetadataLoadedPayload | null {
    const video = this.cachedShowMetadata;
    if (!video) return null;

    const showId = String(video.id);
    const { matchedSeason, matchedEpisode } = this.findSeasonAndEpisode(
      video,
      targetEpisodeId,
    );

    const isSeries = Array.isArray(video.seasons) && video.seasons.length > 0;
    if (isSeries && !matchedEpisode && showId !== targetEpisodeId) {
      return null;
    }
    if (!isSeries && showId !== targetEpisodeId) {
      return null;
    }

    return {
      type: NCW_MESSAGE_TYPES.METADATA_LOADED,
      showId,
      showTitle: video.title,
      showSynopsis: video.synopsis,
      seasonId: matchedSeason ? String(matchedSeason.id) : undefined,
      seasonTitle: matchedSeason ? matchedSeason.title : undefined,
      seasonSeq: matchedSeason ? matchedSeason.seq : undefined,
      currentEpisode: matchedEpisode
        ? {
            episodeId: String(matchedEpisode.id),
            episodeTitle: matchedEpisode.title,
            episodeSeq: matchedEpisode.seq,
            episodeSynopsis: matchedEpisode.synopsis,
          }
        : undefined,
    };
  }

  syncToDomDataset(payload: InjectedMetadataLoadedPayload): void {
    const dataset = document.documentElement.dataset;
    if (!dataset) return;

    dataset.ncwShowId = payload.showId;
    dataset.ncwMainTitle = payload.showTitle;
    if (payload.showSynopsis) dataset.ncwShowSummary = payload.showSynopsis;
    if (payload.seasonId) dataset.ncwSeasonId = payload.seasonId;
    if (payload.currentEpisode) {
      dataset.ncwEpisodeTitle = payload.currentEpisode.episodeTitle;
      if (payload.currentEpisode.episodeSynopsis) {
        dataset.ncwEpisodeSummary = payload.currentEpisode.episodeSynopsis;
      }
    }
  }

  private findSeasonAndEpisode(
    video: NetflixVideoMetadata,
    targetEpisodeId: string,
  ): {
    matchedSeason: NetflixSeasonMetadata | null;
    matchedEpisode: NetflixEpisodeMetadata | null;
  } {
    if (!Array.isArray(video.seasons)) {
      return { matchedSeason: null, matchedEpisode: null };
    }

    for (const season of video.seasons) {
      const ep = season.episodes.find((e: NetflixEpisodeMetadata) => String(e.id) === targetEpisodeId);
      if (ep) {
        return { matchedSeason: season, matchedEpisode: ep };
      }
    }

    // Fallback: match via currentEpisode pointer only if no specific targetEpisodeId was requested
    if (!targetEpisodeId && video.currentEpisode) {
      const currentPointer = String(video.currentEpisode);
      for (const season of video.seasons) {
        const ep = season.episodes.find((e: NetflixEpisodeMetadata) => String(e.id) === currentPointer);
        if (ep) {
          return { matchedSeason: season, matchedEpisode: ep };
        }
      }
    }

    return { matchedSeason: null, matchedEpisode: null };
  }
}
