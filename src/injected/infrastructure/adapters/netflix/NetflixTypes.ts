/**
 * Strict TypeScript Definitions for Netflix Web Player Runtime & API.
 * Reverse-engineered from Netflix Cadmium Web Player.
 * Zero `any`, zero guessing, zero fallbacks.
 */

export interface NetflixTrackCdnUrl {
    readonly cdnId: number;
    readonly url: string;
    readonly cdn_id: number;
}

export interface NetflixPlayerTextTrack {
    readonly trackId: string;
    readonly bcp47: string | null;
    readonly displayName: string;
    readonly trackType: string;
    readonly isNoneTrack: boolean;
    readonly isForcedNarrative: boolean;
    readonly downloadableId: string;
    readonly profile: string;
    readonly urls: readonly NetflixTrackCdnUrl[];
}

export interface NetflixTimedTextTrack {
    readonly trackId: string;
    readonly bcp47: string | null;
    readonly displayName: string;
    readonly trackType: string;
    readonly isNoneTrack: boolean;
    readonly isForcedNarrative: boolean;
}

export interface NetflixInternalPlayer {
    getMovieId(): number;
    getCurrentTime(): number;
    getPlayerPts(): number;
    getContentPts(): number;
    getBufferedTime(): number;
    getTextTrack(): NetflixTimedTextTrack;
    getTextTrackList(): readonly NetflixTimedTextTrack[];
    getPlayerTextTracks(): readonly NetflixPlayerTextTrack[];
    setTextTrack(track: NetflixTimedTextTrack): void;
}

export interface NetflixPlayer {
    getMovieId(): number;
    getSegmentTime(): number;
    isPlaying(): boolean;
    isPaused(): boolean;
    isAd(): boolean;
    getDuration(): number;
    getPlaybackRate(): number;
    getInternalPlayer(): NetflixInternalPlayer;
}

export interface NetflixVideoPlayerApi {
    getAllPlayerSessionIds(): readonly string[];
    getVideoPlayerBySessionId(sessionId: string): NetflixPlayer;
}

export interface NetflixAppContext {
    readonly state: {
        readonly playerApp: {
            getAPI(): {
                readonly videoPlayer: NetflixVideoPlayerApi;
            };
        };
    };
}

export interface NetflixGlobal {
    readonly appContext: NetflixAppContext;
}

declare global {
    interface Window {
        netflix?: NetflixGlobal;
    }
}

// ----------------------------------------------------------------------------
// Official MemberAPI Metadata Schema (/nq/website/memberapi/release/metadata)
// ----------------------------------------------------------------------------

export interface NetflixEpisodeMetadata {
    readonly id: number;
    readonly episodeId: number;
    readonly seq: number;
    readonly title: string;
    readonly synopsis: string;
    readonly runtime: number;
}

export interface NetflixSeasonMetadata {
    readonly id: number;
    readonly seq: number;
    readonly title: string;
    readonly episodes: readonly NetflixEpisodeMetadata[];
}

export interface NetflixVideoMetadata {
    readonly id: number;
    readonly title: string;
    readonly synopsis: string;
    readonly type: string;
    readonly currentEpisode: number;
    readonly seasons?: readonly NetflixSeasonMetadata[];
}

export interface NetflixMetadataApiResponse {
    readonly version: string;
    readonly video: NetflixVideoMetadata;
}

// ----------------------------------------------------------------------------
// Track Registry Domain Models
// ----------------------------------------------------------------------------

export interface KnownTrackDetail {
    readonly showId: string;
    readonly episodeId: string;
    readonly lang: string;
    readonly trackId: string;
    readonly displayName: string;
    readonly trackType: string;
    readonly urls: readonly string[];
    readonly rawText: string;
    readonly interceptedAt: number;
}

export interface UnknownTrackDetail {
    readonly url: string;
    readonly rawText: string;
    readonly interceptedAt: number;
}
