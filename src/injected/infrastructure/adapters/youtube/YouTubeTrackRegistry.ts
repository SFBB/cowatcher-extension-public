import {
    YouTubeTrackItem,
    YouTubeCachedSubtitle,
    YouTubeVideoTrackRecord,
    YouTubePlayerElement,
} from './YouTubeTypes';
import { Logger } from '@shared/utils/logger';

export class YouTubeTrackRegistry {
    private readonly logger = new Logger('YouTubeTrackRegistry');

    private readonly videoRecords = new Map<string, YouTubeVideoTrackRecord>();

    getVideoRecord(videoId: string): YouTubeVideoTrackRecord {
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

    handleInterceptedSubtitle(
        url: string,
        text: string,
        currentVideoId: string | null,
    ): YouTubeCachedSubtitle | null {
        try {
            const urlObj = new URL(url, window.location.origin);
            const videoId =
                urlObj.searchParams.get('v') || currentVideoId || '';
            if (!videoId) return null;

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

            record.cachedSubtitles.set(trackKey, cachedItem);
            record.cachedSubtitles.set(lang, cachedItem);
            record.isFetchingActiveTrack = false;

            if (record.targetLangCode) {
                const targetNormalized = record.targetLangCode
                    .toLowerCase()
                    .split('-')[0];
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
                `Cached timedtext in track store [video: ${videoId}, trackKey: ${trackKey}, bytes: ${text.length}]`,
            );

            return cachedItem;
        } catch (err) {
            this.logger.error('YouTube-AI-Sub', 'Error handling intercepted subtitle:', err);
            return null;
        }
    }

    refreshVideoTracks(
        videoId: string,
        player: YouTubePlayerElement | null,
    ): void {
        const record = this.getVideoRecord(videoId);
        const tracks: YouTubeTrackItem[] = [];

        // 1. Try movie_player getPlayerResponse()
        if (player && typeof player.getPlayerResponse === 'function') {
            try {
                const pr = player.getPlayerResponse();
                const prVideoId = pr?.videoDetails?.videoId;
                if (!prVideoId || prVideoId === videoId) {
                    const rawTracks =
                        pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
                    if (Array.isArray(rawTracks)) {
                        rawTracks.forEach((t) => {
                            if (t && t.languageCode) {
                                tracks.push({
                                    languageCode: t.languageCode,
                                    name: t.name?.simpleText,
                                    vssId: t.vssId,
                                    kind: t.kind,
                                    isAsr:
                                        t.kind === 'asr' ||
                                        (t.vssId ? t.vssId.startsWith('a.') : false),
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
        if (
            tracks.length === 0 &&
            player &&
            typeof player.getOption === 'function'
        ) {
            try {
                const list = player.getOption('captions', 'tracklist') as
                    | readonly {
                          languageCode?: string;
                          name?: string;
                          vssId?: string;
                          kind?: string;
                          baseUrl?: string;
                      }[]
                    | null
                    | undefined;
                if (Array.isArray(list)) {
                    list.forEach((t) => {
                        if (t && t.languageCode) {
                            tracks.push({
                                languageCode: t.languageCode,
                                name: t.name,
                                vssId: t.vssId,
                                kind: t.kind,
                                isAsr:
                                    t.kind === 'asr' ||
                                    (t.vssId ? t.vssId.startsWith('a.') : false),
                                baseUrl: t.baseUrl,
                            });
                        }
                    });
                }
            } catch {}
        }

        // 3. Fallback to window.ytInitialPlayerResponse
        if (
            tracks.length === 0 &&
            window.ytInitialPlayerResponse?.videoDetails?.videoId === videoId
        ) {
            const initTracks =
                window.ytInitialPlayerResponse?.captions
                    ?.playerCaptionsTracklistRenderer?.captionTracks;
            if (Array.isArray(initTracks)) {
                initTracks.forEach((t) => {
                    if (t && t.languageCode) {
                        tracks.push({
                            languageCode: t.languageCode,
                            name: t.name?.simpleText,
                            vssId: t.vssId,
                            kind: t.kind,
                            isAsr:
                                t.kind === 'asr' ||
                                (t.vssId ? t.vssId.startsWith('a.') : false),
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

    async fetchAndCacheTrack(
        videoId: string,
        track: { languageCode?: string; kind?: string; vssId?: string } | null | undefined,
    ): Promise<YouTubeCachedSubtitle | null> {
        if (!track || !track.languageCode) return null;

        const record = this.getVideoRecord(videoId);
        record.isFetchingActiveTrack = true;
        const lang = track.languageCode;
        const isAsr =
            track.kind === 'asr' ||
            (track.vssId ? track.vssId.startsWith('a.') : false);

        const matching = record.tracks.find(
            (t) =>
                t.languageCode === lang ||
                (t.vssId && track.vssId && t.vssId === track.vssId),
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
            return null;
        }

        if (!fetchUrl.includes('fmt=')) {
            fetchUrl += '&fmt=json3';
        }

        try {
            const res = await fetch(fetchUrl);
            if (res.ok) {
                const text = await res.text();
                if (text && text.length > 0) {
                    return this.handleInterceptedSubtitle(fetchUrl, text, videoId);
                }
            }
        } catch (err) {
            this.logger.warn('YouTube-AI-Sub', 'Direct fetch for track failed:', err);
        } finally {
            record.isFetchingActiveTrack = false;
        }
        return null;
    }

    async checkAndCacheNativeTargetTrack(
        videoId: string,
        targetLangCode: string,
        player: YouTubePlayerElement | null,
    ): Promise<YouTubeCachedSubtitle | null> {
        const record = this.getVideoRecord(videoId);
        record.targetLangCode = targetLangCode;

        this.refreshVideoTracks(videoId, player);
        if (record.tracks.length === 0) return null;

        const targetCode = targetLangCode.toLowerCase();
        const targetPrefix = targetCode.split('-')[0];

        const match =
            record.tracks.find((t) => {
                const c = (t.languageCode || '').toLowerCase();
                return !t.isAsr && (c === targetCode || c.startsWith(targetPrefix));
            }) ||
            record.tracks.find((t) => {
                const c = (t.languageCode || '').toLowerCase();
                return c === targetCode || c.startsWith(targetPrefix);
            });

        if (!match) return null;

        record.isFetchingNativeTrack = true;
        this.logger.info(
            'YouTube-AI-Sub',
            `Directly fetching native target track (${match.languageCode}) for ${videoId}...`,
        );

        let fetchUrl = match.baseUrl;
        if (!fetchUrl && videoId) {
            fetchUrl = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${match.languageCode}&fmt=json3${match.isAsr ? '&kind=asr' : ''}`;
        }

        if (fetchUrl) {
            try {
                if (!fetchUrl.includes('fmt=')) fetchUrl += '&fmt=json3';
                const res = await fetch(fetchUrl);
                if (res.ok) {
                    const text = await res.text();
                    if (text && text.length > 0) {
                        const cached = this.handleInterceptedSubtitle(fetchUrl, text, videoId);
                        record.nativeTrackCached = true;
                        record.isFetchingNativeTrack = false;
                        return cached;
                    }
                }
            } catch (err) {
                this.logger.warn('YouTube-AI-Sub', 'Direct native track fetch failed:', err);
            } finally {
                record.isFetchingNativeTrack = false;
            }
        }

        return null;
    }

    async getTrack(
        videoId: string,
        player: YouTubePlayerElement | null,
    ): Promise<{
        status: 'resolved' | 'null' | 'undefined';
        subtitle?: YouTubeCachedSubtitle;
    }> {
        if (!videoId) return { status: 'undefined' };

        // Guard against video desync during SPA transitions
        if (player && typeof player.getVideoData === 'function') {
            const vData = player.getVideoData();
            if (vData?.video_id && vData.video_id !== videoId) {
                return { status: 'undefined' };
            }
        }

        const record = this.getVideoRecord(videoId);
        this.refreshVideoTracks(videoId, player);

        const playerState = typeof player?.getPlayerState === 'function' ? player.getPlayerState() : -1;

        // If tracks are still empty:
        if (record.tracks.length === 0) {
            // If player is still unstarted / buffering initial video load (-1 or null), tracks are pending
            if (playerState === -1 || !player) {
                return { status: 'undefined' };
            }
            // Genuinely confirmed no captions available on this video
            return { status: 'null' };
        }

        // Check player's active caption selection
        const currentOpt =
            typeof player?.getOption === 'function'
                ? (player.getOption('captions', 'track') as { languageCode?: string; kind?: string; vssId?: string } | null)
                : null;
        const isCaptionsOff = !currentOpt || !currentOpt.languageCode;

        if (isCaptionsOff) {
            // If player has not started yet (-1), captions might still be setting up
            if (playerState === -1 || !player) {
                return { status: 'undefined' };
            }
            return { status: 'null' };
        }

        const targetTrack =
            record.tracks.find((t) => t.languageCode === currentOpt.languageCode) ||
            record.tracks[0];

        const cached =
            record.cachedSubtitles.get(targetTrack.languageCode) ||
            (record.activeTrackKey
                ? record.cachedSubtitles.get(record.activeTrackKey)
                : undefined);

        if (cached && cached.rawText) {
            return { status: 'resolved', subtitle: cached };
        }

        // Cache miss: actively fetch
        this.fetchAndCacheTrack(videoId, targetTrack);
        return { status: 'undefined' };
    }

    clear(): void {
        this.videoRecords.clear();
    }
}
