import { IInjectedAdapter } from '../../../domain/IInjectedAdapter';
import { VideoMetadata } from '../../../../content/domain/adapters/IStreamingAdapter';
import {
    STREAMING_PLATFORMS,
    StreamingPlatformId,
} from '@shared/domain/constants/StreamingPlatforms';
import { NCW_MESSAGE_TYPES } from '@shared/domain/constants/MessageTypes';
import { Logger } from '@shared/utils/logger';

declare global {
    interface Window {
        streaksplayer?: {
            getPlayers: () => Record<string, any>;
        };
        __NCW_TVER_INTERCEPTOR_INITIALIZED__?: boolean;
        __NCW_TVER_CAPTURED_TOKEN__?: {
            token: string;
            uid?: string;
            capturedAt?: number;
        };
    }
}

export class TVerInjectedAdapter implements IInjectedAdapter {
    readonly platformId: StreamingPlatformId = STREAMING_PLATFORMS.TVER;
    private readonly logger: Logger = new Logger('TVerInjectedAdapter');

    private lastEmittedSignature: string = '';
    private lastInterceptedSubtitle: {
        episodeId: string | null;
        url: string;
        text: string;
        lang: string;
        timestamp: number;
    } | null = null;

    private lastReportedUrl: string = '';
    private lastObservedEpisodeId: string | null = null;
    private lastTrackState: string = '';
    private lastAdState: boolean = false;
    private lastReportedTime: number | null = null;
    private lastTimeUpdateSync: number = 0;
    private pollIntervalId: NodeJS.Timeout | number | null = null;
    private messageListener: ((e: MessageEvent) => void) | null = null;

    private capturedToken: string | null = null;
    private capturedUid: string | null = null;
    private hasFetchedSeriesMetadata: Set<string> = new Set();
    private lastMetaPayload: any = null;

    matches(url: string): boolean {
        return /tver\.jp/i.test(url);
    }

    initialize(): void {
        if (window.__NCW_TVER_INTERCEPTOR_INITIALIZED__) return;
        window.__NCW_TVER_INTERCEPTOR_INITIALIZED__ = true;

        this.lastReportedUrl = window.location.href;
        this.lastObservedEpisodeId = this.extractEpisodeId(
            window.location.href,
        );

        this.logger.info(
            'TVer-AI-Sub',
            'Initializing TVer Injected Adapter in MAIN world.',
        );

        this.hookNetwork();
        this.hookRouting();
        this.hookPlayerEvents();
        this.setupMessageListener();

        // Start background sync polling
        this.pollIntervalId = setInterval(() => {
            this.notifyUrlChange();
            this.checkTVerPlayerState();
        }, 500);

        // Initial check
        setTimeout(() => {
            this.checkTVerPlayerState();
            this.tryExtractFromTextTracks();
        }, 1000);
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
    }

    // --- Helpers ---
    private extractEpisodeId(url?: string): string | null {
        const match = (url || window.location.href || '').match(
            /\/episodes\/([a-zA-Z0-9_-]+)/,
        );
        return match ? match[1] : null;
    }

    private isSubtitleContent(text: string): boolean {
        if (!text || typeof text !== 'string') return false;
        const clean = text.replace(/^\uFEFF/, '').trim();
        const snippet = clean.slice(0, 2000);

        if (
            snippet.startsWith('WEBVTT') ||
            snippet.includes('WEBVTT') ||
            snippet.includes('-->')
        ) {
            return true;
        }
        if (
            snippet.includes('<tt') ||
            snippet.includes('<timedtext') ||
            snippet.includes('begin="')
        ) {
            return true;
        }
        return false;
    }

    private formatVttTime(seconds: number): string {
        if (typeof seconds !== 'number' || isNaN(seconds) || seconds < 0)
            seconds = 0;
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        const pad = (n: number | string, z = 2) => String(n).padStart(z, '0');
        return `${pad(h)}:${pad(m)}:${pad(s.toFixed(3), 6)}`;
    }

    private textTrackToWebVTT(track: any): string | null {
        const cues = track?.cues_ || track?.cues;
        if (!cues || cues.length === 0) return null;

        let out = 'WEBVTT\n\n';
        for (let i = 0; i < cues.length; i++) {
            const cue = cues[i];
            if (
                typeof cue.startTime !== 'number' ||
                typeof cue.endTime !== 'number'
            )
                continue;
            const start = this.formatVttTime(cue.startTime);
            const end = this.formatVttTime(cue.endTime);
            const text =
                cue.text ||
                cue.rawText ||
                cue.getCueAsHTML?.()?.textContent ||
                '';
            if (!text.trim()) continue;
            out += `${i + 1}\n${start} --> ${end}\n${text.trim()}\n\n`;
        }
        return out.length > 20 ? out : null;
    }

    private emitSubtitleData(
        url: string,
        text: string,
        force = false,
        explicitEpisodeId: string | null = null,
        explicitLang = 'ja',
    ): void {
        try {
            if (!text || text.length < 20) return;

            const currentActiveId = this.extractEpisodeId(window.location.href);
            const effectiveId = explicitEpisodeId || currentActiveId;

            this.lastInterceptedSubtitle = {
                episodeId: effectiveId,
                url: url || window.location.href,
                text,
                lang: explicitLang || 'ja',
                timestamp: Date.now(),
            };

            const signature = `${effectiveId || ''}_${text.length}_${text.slice(0, 80)}_${text.slice(-80)}`;
            if (!force && signature === this.lastEmittedSignature) {
                return;
            }
            this.lastEmittedSignature = signature;

            window.postMessage(
                {
                    type: NCW_MESSAGE_TYPES.SUBTITLE_RAW_DATA,
                    movieId: effectiveId,
                    url: url || window.location.href,
                    pageUrl: window.location.href,
                    rawText: text,
                    bcp47: explicitLang || 'ja',
                    timestamp: Date.now(),
                },
                '*',
            );
            this.logger.info(
                'TVer-AI-Sub',
                `Emitted subtitle payload for episode (${effectiveId || 'active'}), length: ${text.length}`,
            );
        } catch (e) {
            this.logger.error(
                'TVer-AI-Sub',
                'Failed to post subtitle message:',
                e,
            );
        }
    }

    // --- Network Interceptor (Fetch & XHR) ---
    private hookNetwork(): void {
        const originalFetch = window.fetch;
        const self = this;

        window.fetch = async function (...args: any[]) {
            const response = await (originalFetch as any).apply(this, args);
            try {
                const rawUrl =
                    typeof args[0] === 'string'
                        ? args[0]
                        : args[0]?.url || response.url || '';
                const url = rawUrl.toLowerCase();

                // 1. Intercept platform_token & platform_uid from API queries
                if (url.includes('platform_token=')) {
                    try {
                        const u = new URL(rawUrl, window.location.href);
                        const token = u.searchParams.get('platform_token');
                        const uid = u.searchParams.get('platform_uid');
                        if (token) {
                            self.capturedToken = token;
                            if (uid) self.capturedUid = uid;
                            window.__NCW_TVER_CAPTURED_TOKEN__ = {
                                token,
                                uid: uid || undefined,
                                capturedAt: Date.now(),
                            };
                            self.logger.info(
                                'TVer-AI-Sub',
                                `Captured platform_token (${token.slice(0, 8)}...)`,
                            );
                            self.triggerMetadataFetchIfReady();
                        }
                    } catch {
                        // Ignore URL parsing errors
                    }
                }

                // 2. Intercept series episodes response directly if TVer requested it
                if (url.includes('/callseriesepisodes/')) {
                    const clone = response.clone();
                    clone
                        .json()
                        .then((data: any) => {
                            self.handleSeriesEpisodesResponse(data);
                        })
                        .catch(() => {});
                }

                // 3. Intercept subtitle files (.vtt, .ttml, etc.) - Ignore thumbnails!
                const isCandidate =
                    !url.includes('thumbnail') &&
                    (url.includes('.vtt') ||
                        url.includes('webvtt') ||
                        url.includes('.ttml') ||
                        url.includes('arib') ||
                        url.includes('subtitles') ||
                        url.includes('caption') ||
                        url.includes('track/'));

                if (isCandidate) {
                    const clone = response.clone();
                    clone
                        .text()
                        .then((text: string) => {
                            if (self.isSubtitleContent(text)) {
                                self.emitSubtitleData(rawUrl, text);
                            }
                        })
                        .catch(() => {});
                }
            } catch {
                // Never break page requests
            }
            return response;
        };

        // XHR Hook
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function (
            this: any,
            method: string,
            url: string | URL,
            ...rest: any[]
        ) {
            this._ncw_url = typeof url === 'string' ? url : url.href;
            return origOpen.apply(this, [method, url, ...rest] as any);
        };

        XMLHttpRequest.prototype.send = function (this: any, ...args: any[]) {
            this.addEventListener(
                'load',
                () => {
                    try {
                        const rawUrl = this._ncw_url || this.responseURL || '';
                        const url = rawUrl.toLowerCase();

                        // Token detection
                        if (url.includes('platform_token=')) {
                            try {
                                const u = new URL(rawUrl, window.location.href);
                                const token =
                                    u.searchParams.get('platform_token');
                                const uid = u.searchParams.get('platform_uid');
                                if (token) {
                                    self.capturedToken = token;
                                    if (uid) self.capturedUid = uid;
                                    window.__NCW_TVER_CAPTURED_TOKEN__ = {
                                        token,
                                        uid: uid || undefined,
                                        capturedAt: Date.now(),
                                    };
                                    self.triggerMetadataFetchIfReady();
                                }
                            } catch {}
                        }

                        // Series episodes JSON
                        if (url.includes('/callseriesepisodes/')) {
                            try {
                                const text = this.responseText;
                                if (text) {
                                    const data = JSON.parse(text);
                                    self.handleSeriesEpisodesResponse(data);
                                }
                            } catch {}
                        }

                        // Subtitle text
                        if (!url.includes('thumbnail')) {
                            const text = this.responseText;
                            if (
                                typeof text === 'string' &&
                                self.isSubtitleContent(text)
                            ) {
                                self.emitSubtitleData(rawUrl, text);
                            }
                        }
                    } catch {}
                },
                { passive: true },
            );
            return (origSend as any).apply(this, args);
        };
    }

    // --- TVer Player Hook ---
    private getTVerPlayer(): any {
        try {
            const video =
                (document.getElementById('video-player') as any) ||
                (document.querySelector('video') as any);
            if (!video) return null;
            const players = window.streaksplayer?.getPlayers?.() || {};
            return (
                (video.playerId && players[video.playerId]) ||
                Object.values(players)[0] ||
                null
            );
        } catch {
            return null;
        }
    }

    /**
     * Extract subtitle from StreaksPlayer textTracks().tracks_
     */
    private tryExtractFromTextTracks(
        force = false,
        targetTrack?: any,
        targetIndex?: number,
    ): boolean {
        try {
            const video =
                (document.getElementById('video-player') as any) ||
                (document.querySelector('video') as any);
            const player = this.getTVerPlayer();

            const trackList =
                (player && typeof player.textTracks === 'function'
                    ? player.textTracks()?.tracks_ || player.textTracks()
                    : null) ||
                (video && video.textTracks ? video.textTracks : null);

            if (!trackList || trackList.length === 0) return false;

            const candidates: any[] = [];

            if (targetTrack) {
                const cues = targetTrack.cues_ || targetTrack.cues;
                const cueCount = cues && cues.length ? cues.length : 0;
                candidates.push({
                    track: targetTrack,
                    src: targetTrack.src || '',
                    cueCount,
                    index: targetIndex ?? 0,
                });
            } else {
                for (let i = 0; i < trackList.length; i++) {
                    const track = trackList[i];
                    if (!track) continue;

                    const src = (track.src || '').toLowerCase();
                    if (src.includes('thumbnail')) continue;

                    const kind = (track.kind || '').toLowerCase();
                    if (kind === 'metadata' || kind === 'chapters') continue;

                    const cues = track.cues_ || track.cues;
                    const cueCount = cues && cues.length ? cues.length : 0;

                    candidates.push({
                        track,
                        src: track.src || '',
                        cueCount,
                        index: i,
                    });
                }
                candidates.sort((a, b) => b.cueCount - a.cueCount);
            }

            for (const item of candidates) {
                const { track, src, cueCount, index } = item;
                if (cueCount > 0) {
                    const vtt = this.textTrackToWebVTT(track);
                    if (vtt && vtt.length > 20) {
                        const trackId = `track_${track.label || track.language || index}`;
                        this.emitSubtitleData(
                            trackId,
                            vtt,
                            force,
                            null,
                            track.language || 'ja',
                        );
                        return true;
                    }
                } else if (src) {
                    fetch(src)
                        .then((r) => r.arrayBuffer())
                        .then((buf) => {
                            const text = new TextDecoder('utf-8').decode(buf);
                            if (this.isSubtitleContent(text)) {
                                this.emitSubtitleData(
                                    src,
                                    text,
                                    force,
                                    null,
                                    track.language || 'ja',
                                );
                            }
                        })
                        .catch(() => {});
                }
            }
        } catch (e) {
            this.logger.warn(
                'TVer-AI-Sub',
                'Error in tryExtractFromTextTracks:',
                e,
            );
        }
        return false;
    }

    private checkTVerTextTracks(): void {
        try {
            const video =
                (document.getElementById('video-player') as any) ||
                (document.querySelector('video') as any);
            const player = this.getTVerPlayer();

            const trackList =
                (player && typeof player.textTracks === 'function'
                    ? player.textTracks()?.tracks_ || player.textTracks()
                    : null) ||
                (video && video.textTracks ? video.textTracks : null);

            if (!trackList || trackList.length === 0) return;

            let activeTrack: any = null;
            let activeTrackIndex = -1;

            for (let i = 0; i < trackList.length; i++) {
                const track = trackList[i];
                if (!track) continue;

                const src = (track.src || '').toLowerCase();
                if (src.includes('thumbnail')) continue;

                const kind = (track.kind || '').toLowerCase();
                if (kind === 'metadata' || kind === 'chapters') continue;

                if (track.mode === 'showing') {
                    activeTrack = track;
                    activeTrackIndex = i;
                    break;
                }
            }

            const currentEpId = this.extractEpisodeId(window.location.href);

            if (activeTrack) {
                const trackSig = String(
                    activeTrack.id ||
                        activeTrack.label ||
                        activeTrack.language ||
                        activeTrackIndex,
                );
                if (this.lastTrackState !== trackSig) {
                    this.logger.info(
                        'TVer-AI-Sub',
                        `Subtitle track changed on TVer: "${this.lastTrackState}" -> "${trackSig}". Extracting...`,
                    );
                    this.lastTrackState = trackSig;
                    this.tryExtractFromTextTracks(
                        true,
                        activeTrack,
                        activeTrackIndex,
                    );
                }
            } else {
                // No showing track -> OFF
                if (this.lastTrackState && this.lastTrackState !== '__OFF__') {
                    this.logger.info(
                        'TVer-AI-Sub',
                        `All subtitle tracks disabled on TVer. Posting SUBTITLE_OFF.`,
                    );
                    this.lastTrackState = '__OFF__';
                    window.postMessage(
                        {
                            type: NCW_MESSAGE_TYPES.SUBTITLE_OFF,
                            movieId: currentEpId,
                            timestamp: Date.now(),
                        },
                        '*',
                    );
                }
            }
        } catch (e) {
            this.logger.warn('TVer-AI-Sub', 'Error in checkTVerTextTracks:', e);
        }
    }

    // --- Player State & Time Synchronization ---
    private checkTVerPlayerState(): void {
        try {
            const video =
                (document.getElementById('video-player') as HTMLVideoElement) ||
                document.querySelector('video');
            const player = this.getTVerPlayer();

            // 1. Authoritative Ad Break Detection (StreaksPlayer native methods)
            let isAd = false;
            if (player) {
                if (typeof player.inAdBreak === 'function') {
                    isAd = Boolean(player.inAdBreak());
                } else if (typeof player.isInAdMode === 'function') {
                    isAd = Boolean(player.isInAdMode());
                } else if (typeof player.isInPreroll === 'function') {
                    isAd = Boolean(player.isInPreroll());
                }
                if (
                    !isAd &&
                    typeof player.currentAd === 'function' &&
                    player.currentAd()
                ) {
                    isAd = true;
                }
            }
            if (!isAd) {
                // Only active/visible ad playing markers (NOT static containers)
                const activeAdEl = document.querySelector(
                    '.vjs-ad-playing, .vjs-ad-loading',
                );
                if (
                    activeAdEl &&
                    (activeAdEl as HTMLElement).offsetParent !== null
                ) {
                    isAd = true;
                }
            }

            if (isAd !== this.lastAdState) {
                this.lastAdState = isAd;
                this.logger.info(
                    'TVer-AI-Sub',
                    `TVer Ad State changed: ${isAd}`,
                );
                window.postMessage(
                    { type: NCW_MESSAGE_TYPES.AD_STATE_CHANGED, isAd },
                    '*',
                );
            }

            if (isAd) return;

            // 2. Playback Presentation Time Synchronization (StreaksPlayer currentContentTime)
            if (video) {
                let curTime = 0;
                if (player && typeof player.currentContentTime === 'function') {
                    try {
                        const t = player.currentContentTime();
                        if (typeof t === 'number' && !isNaN(t) && t >= 0)
                            curTime = t;
                    } catch {}
                }
                if (
                    !curTime &&
                    player &&
                    typeof player.currentTime === 'function'
                ) {
                    try {
                        const t = player.currentTime();
                        if (typeof t === 'number' && !isNaN(t) && t >= 0)
                            curTime = t;
                    } catch {}
                }
                if (!curTime && typeof video.currentTime === 'number') {
                    curTime = video.currentTime;
                }

                const isPaused = video.paused;
                const playbackRate = video.playbackRate || 1.0;
                const nowPerf = performance.now();

                if (document.documentElement) {
                    document.documentElement.dataset.ncwSegmentAtomic = `${curTime}|${nowPerf}|${isPaused ? 1 : 0}|${playbackRate}`;
                    document.documentElement.dataset.ncwSegmentTime =
                        String(curTime);
                    document.documentElement.dataset.ncwSegmentSyncAt =
                        String(nowPerf);
                    document.documentElement.dataset.ncwIsPaused = isPaused
                        ? 'true'
                        : 'false';
                    document.documentElement.dataset.ncwPlaybackRate =
                        String(playbackRate);
                }

                if (
                    this.lastReportedTime === null ||
                    Math.abs(curTime - this.lastReportedTime) > 0.5
                ) {
                    this.lastReportedTime = curTime;
                    window.postMessage(
                        {
                            type: NCW_MESSAGE_TYPES.TIME_SYNC,
                            segmentTime: curTime,
                            syncAt: nowPerf,
                            isPaused,
                            playbackRate,
                            cadmiumOffset: 0,
                            adOffset: 0,
                        },
                        '*',
                    );
                }
            }

            // Check series metadata trigger if player ready
            this.triggerMetadataFetchIfReady();

            // Check text track change or OFF state
            this.checkTVerTextTracks();

            // If no subtitle captured yet, attempt extraction
            if (
                !this.lastInterceptedSubtitle &&
                this.lastTrackState !== '__OFF__'
            ) {
                this.tryExtractFromTextTracks();
            }
        } catch {}
    }

    // --- Series Metadata Fetching & Parsing ---
    private triggerMetadataFetchIfReady(): void {
        try {
            const player = this.getTVerPlayer();
            const adFields = player?.getMedia?.()?.adFields || {};
            const seriesId = adFields.ad_series_id;
            const pUid =
                adFields.platformUid ||
                adFields.platformAdUid ||
                this.capturedUid;
            const pToken =
                this.capturedToken || window.__NCW_TVER_CAPTURED_TOKEN__?.token;

            if (
                !seriesId ||
                !pToken ||
                this.hasFetchedSeriesMetadata.has(seriesId)
            ) {
                return;
            }
            this.hasFetchedSeriesMetadata.add(seriesId);

            const url = new URL(
                `https://platform-api.tver.jp/service/api/v1/callSeriesEpisodes/${seriesId}`,
            );
            if (pUid) url.searchParams.append('platform_uid', pUid);
            url.searchParams.append('platform_token', pToken);
            url.searchParams.append('require_data', 'later,good,resume');

            fetch(url.toString(), {
                headers: {
                    'x-tver-platform-type': 'web',
                    accept: 'application/json, text/plain, */*',
                },
            })
                .then((r) => r.json())
                .then((data) => {
                    this.handleSeriesEpisodesResponse(data);
                })
                .catch((err) => {
                    this.logger.warn(
                        'TVer-AI-Sub',
                        'Failed fetching series episodes metadata:',
                        err,
                    );
                });
        } catch {}
    }

    private handleSeriesEpisodesResponse(data: any): void {
        try {
            const currentEpId = this.extractEpisodeId(window.location.href);
            const rawGroups = data?.result?.contents || [];

            let foundSeriesTitle = '';
            let foundSeriesId = '';
            let currentEpisodeInfo: any = null;

            for (const group of rawGroups) {
                const items = group?.contents || [];
                for (const item of items) {
                    if (item?.type === 'episode' && item.content) {
                        const c = item.content;
                        if (!foundSeriesTitle && c.seriesTitle) {
                            foundSeriesTitle = c.seriesTitle;
                        }
                        if (!foundSeriesId && c.seriesID) {
                            foundSeriesId = c.seriesID;
                        }
                        if (c.id === currentEpId || !currentEpisodeInfo) {
                            currentEpisodeInfo = c;
                        }
                    }
                }
            }

            if (foundSeriesTitle || currentEpisodeInfo) {
                const metaPayload = {
                    type: NCW_MESSAGE_TYPES.METADATA_LOADED,
                    showId:
                        foundSeriesId ||
                        currentEpisodeInfo?.seriesID ||
                        currentEpId ||
                        '',
                    showTitle:
                        foundSeriesTitle ||
                        currentEpisodeInfo?.seriesTitle ||
                        document.title,
                    currentEpisode: currentEpisodeInfo
                        ? {
                              episodeId: currentEpisodeInfo.id,
                              episodeTitle: currentEpisodeInfo.title,
                              episodeSynopsis:
                                  currentEpisodeInfo.broadcastDateLabel || '',
                          }
                        : undefined,
                    rawMetadata: data,
                };

                if (document.documentElement) {
                    document.documentElement.dataset.ncwShowId =
                        metaPayload.showId;
                    document.documentElement.dataset.ncwMainTitle =
                        metaPayload.showTitle;
                    if (currentEpisodeInfo?.title) {
                        document.documentElement.dataset.ncwEpisodeTitle =
                            currentEpisodeInfo.title;
                    }
                }

                this.lastMetaPayload = metaPayload;
                window.postMessage(metaPayload, '*');
                this.logger.info(
                    'TVer-AI-Sub',
                    `Dispatched METADATA_LOADED: Series "${metaPayload.showTitle}" [${metaPayload.showId}], Ep: "${currentEpisodeInfo?.title}"`,
                );
            }
        } catch (e) {
            this.logger.warn(
                'TVer-AI-Sub',
                'Error parsing callSeriesEpisodes data:',
                e,
            );
        }
    }

    // --- SPA Route & Player Event Hooks ---
    private notifyUrlChange(): void {
        const current = window.location.href;
        if (current !== this.lastReportedUrl) {
            this.lastReportedUrl = current;
            this.lastEmittedSignature = '';

            const newEpId = this.extractEpisodeId(current);
            if (newEpId && newEpId !== this.lastObservedEpisodeId) {
                this.lastObservedEpisodeId = newEpId;
                this.lastTrackState = '';
                window.postMessage(
                    {
                        type: NCW_MESSAGE_TYPES.EPISODE_CHANGED,
                        movieId: newEpId,
                        url: current,
                    },
                    '*',
                );
                setTimeout(() => this.tryExtractFromTextTracks(true), 600);
            }

            window.postMessage(
                {
                    type: NCW_MESSAGE_TYPES.URL_CHANGED,
                    url: current,
                },
                '*',
            );
        }
    }

    private hookRouting(): void {
        const origPushState = history.pushState;
        const self = this;
        history.pushState = function (...args: any[]) {
            const res = (origPushState as any).apply(this, args);
            self.notifyUrlChange();
            return res;
        };

        const origReplaceState = history.replaceState;
        history.replaceState = function (...args: any[]) {
            const res = (origReplaceState as any).apply(this, args);
            self.notifyUrlChange();
            return res;
        };

        window.addEventListener('popstate', () => this.notifyUrlChange());
    }

    private hookPlayerEvents(): void {
        ['seeked', 'playing', 'pause', 'ratechange'].forEach((evt) => {
            window.addEventListener(
                evt,
                () => setTimeout(() => this.checkTVerPlayerState(), 50),
                {
                    capture: true,
                    passive: true,
                },
            );
        });

        window.addEventListener(
            'timeupdate',
            () => {
                const now = performance.now();
                if (now - this.lastTimeUpdateSync > 250) {
                    this.lastTimeUpdateSync = now;
                    this.checkTVerPlayerState();
                }
            },
            { capture: true, passive: true },
        );
    }

    private setupMessageListener(): void {
        this.messageListener = (event: MessageEvent) => {
            if (event.source !== window || !event.data) return;
            if (event.data.type === NCW_MESSAGE_TYPES.REQUEST_SUBTITLE_RETRY) {
                const currentEpId = this.extractEpisodeId(window.location.href);
                this.lastEmittedSignature = '';

                if (
                    this.lastInterceptedSubtitle &&
                    this.lastInterceptedSubtitle.text
                ) {
                    this.logger.info(
                        'TVer-AI-Sub',
                        `Re-emitting cached subtitle for episode (${currentEpId || 'active'}).`,
                    );
                    window.postMessage(
                        {
                            type: NCW_MESSAGE_TYPES.SUBTITLE_RAW_DATA,
                            movieId:
                                this.lastInterceptedSubtitle.episodeId ||
                                currentEpId,
                            url: this.lastInterceptedSubtitle.url,
                            rawText: this.lastInterceptedSubtitle.text,
                            bcp47: this.lastInterceptedSubtitle.lang || 'ja',
                            timestamp: Date.now(),
                            isReplay: true,
                        },
                        '*',
                    );
                    return;
                }
                this.tryExtractFromTextTracks(true);
            }

            if (event.data.type === NCW_MESSAGE_TYPES.REQUEST_METADATA) {
                if (this.lastMetaPayload) {
                    this.logger.info(
                        'TVer-AI-Sub',
                        'Re-emitting cached series metadata upon REQUEST_METADATA.',
                    );
                    window.postMessage(this.lastMetaPayload, '*');
                }
            }

            if (event.data.type === NCW_MESSAGE_TYPES.QUERY_METADATA) {
                const queryId = event.data.queryId;
                const targetEpId = event.data.movieId
                    ? String(event.data.movieId)
                    : this.extractEpisodeId(window.location.href);

                const respond = (
                    status: 'resolved' | 'null' | 'undefined',
                    metadata?: VideoMetadata,
                ) => {
                    window.postMessage(
                        {
                            type: NCW_MESSAGE_TYPES.QUERY_METADATA_RESULT,
                            queryId,
                            status,
                            metadata,
                        },
                        '*',
                    );
                };

                if (!targetEpId) {
                    respond('undefined');
                    return;
                }

                if (this.lastMetaPayload) {
                    const p = this.lastMetaPayload;
                    const currentEp = p.currentEpisode;
                    if (
                        currentEp &&
                        (!targetEpId || currentEp.episodeId === targetEpId)
                    ) {
                        const meta: VideoMetadata = {
                            mainTitle: p.showTitle || '',
                            episodeTitle: currentEp.episodeTitle || '',
                            fullTitle: currentEp.episodeTitle
                                ? p.showTitle
                                    ? `${p.showTitle} - ${currentEp.episodeTitle}`
                                    : currentEp.episodeTitle
                                : p.showTitle || '',
                            videoId: currentEp.episodeId || targetEpId,
                            showId: p.showId || targetEpId,
                            seasonId: p.seasonId,
                            showSummary: p.showSynopsis,
                            episodeSummary: currentEp.episodeSynopsis,
                            seasonNum: p.seasonSeq,
                            episodeNum: currentEp.episodeSeq,
                        };
                        respond('resolved', meta);
                        return;
                    }
                }

                this.triggerMetadataFetchIfReady();
                respond('undefined');
            }

            if (event.data.type === NCW_MESSAGE_TYPES.QUERY_SUBTITLE) {
                const queryId = event.data.queryId;
                const requestedMid = event.data.movieId
                    ? String(event.data.movieId)
                    : null;
                const targetEpId =
                    requestedMid ||
                    this.lastObservedEpisodeId ||
                    this.extractEpisodeId(window.location.href);

                const respond = (
                    status: 'resolved' | 'null' | 'undefined',
                    payload?: { rawText: string; bcp: string },
                ) => {
                    window.postMessage(
                        {
                            type: NCW_MESSAGE_TYPES.QUERY_SUBTITLE_RESULT,
                            queryId,
                            status,
                            rawText: payload?.rawText,
                            bcp: payload?.bcp,
                        },
                        '*',
                    );
                };

                if (!targetEpId) {
                    respond('undefined');
                    return;
                }

                if (
                    this.lastInterceptedSubtitle &&
                    this.lastInterceptedSubtitle.text
                ) {
                    if (
                        !this.lastInterceptedSubtitle.episodeId ||
                        this.lastInterceptedSubtitle.episodeId === targetEpId
                    ) {
                        respond('resolved', {
                            rawText: this.lastInterceptedSubtitle.text,
                            bcp: this.lastInterceptedSubtitle.lang || 'ja',
                        });
                        return;
                    }
                }

                // Try extracting from active video element text tracks
                const extracted = this.tryExtractFromTextTracks(false);
                if (extracted && this.lastInterceptedSubtitle?.text) {
                    respond('resolved', {
                        rawText: this.lastInterceptedSubtitle.text,
                        bcp: this.lastInterceptedSubtitle.lang || 'ja',
                    });
                    return;
                }

                const video = document.querySelector('video');
                if (video && video.currentTime > 2) {
                    respond('null');
                } else {
                    respond('undefined');
                }
            }
        };
        window.addEventListener('message', this.messageListener);
    }
}
