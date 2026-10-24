/**
 * Strict TypeScript Definitions for YouTube Web Player Runtime & API.
 * Reverse-engineered from YouTube HTML5 Desktop Player (#movie_player).
 */

export interface YouTubeTrackItem {
    readonly languageCode: string;
    readonly name?: string;
    readonly vssId?: string;
    readonly kind?: string;
    readonly isAsr?: boolean;
    readonly baseUrl?: string;
    readonly isDefault?: boolean;
}

export interface YouTubeCachedSubtitle {
    readonly trackKey: string;
    readonly videoId: string;
    readonly languageCode: string;
    readonly isAsr: boolean;
    readonly rawText: string;
    readonly url: string;
    readonly timestamp: number;
}

export interface YouTubeVideoTrackRecord {
    readonly videoId: string;
    tracks: YouTubeTrackItem[];
    readonly cachedSubtitles: Map<string, YouTubeCachedSubtitle>;
    activeTrackKey: string | null;
    targetLangCode?: string;
    nativeTrackCached?: boolean;
    lastEmittedSignature?: string;
    userExplicitlyDisabledCaptions?: boolean;
    isFetchingActiveTrack?: boolean;
    isFetchingNativeTrack?: boolean;
}

export interface YouTubePlayerVideoData {
    readonly video_id?: string;
    readonly title?: string;
    readonly author?: string;
    readonly [key: string]: unknown;
}

export interface YouTubePlayerResponse {
    readonly videoDetails?: {
        readonly videoId?: string;
        readonly title?: string;
        readonly author?: string;
        readonly shortDescription?: string;
        readonly [key: string]: unknown;
    };
    readonly captions?: {
        readonly playerCaptionsTracklistRenderer?: {
            readonly captionTracks?: readonly {
                readonly languageCode: string;
                readonly name?: { readonly simpleText?: string };
                readonly vssId?: string;
                readonly kind?: string;
                readonly baseUrl?: string;
                readonly isDefault?: boolean;
            }[];
        };
    };
    readonly [key: string]: unknown;
}

export interface YouTubePlayerElement {
    getVideoData?(): YouTubePlayerVideoData;
    getPlayerResponse?(): YouTubePlayerResponse;
    getOption?(module: string, option: string): unknown;
    setOption?(module: string, option: string, value: unknown): unknown;
    getPlayerState?(): number;
    getCurrentTime?(): number;
    getPlaybackRate?(): number;
    getAdState?(): number;
    classList?: DOMTokenList;
    addEventListener?(event: string, listener: (...args: unknown[]) => void): void;
    removeEventListener?(event: string, listener: (...args: unknown[]) => void): void;
}

declare global {
    interface Window {
        __NCW_YOUTUBE_INTERCEPTOR_INITIALIZED__?: boolean;
        ytInitialPlayerResponse?: YouTubePlayerResponse;
        ytplayer?: YouTubePlayerElement;
    }
}
