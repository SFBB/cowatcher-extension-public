import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubtitleCue } from '@shared/domain/entities/Subtitle';
import {
    NCW_DATASET_SYNC_KEY,
    PlaybackDatasetPayload,
} from '@shared/domain/entities/PlaybackDatasetPayload';
import { SubtitleOverlay } from '../../presentation/SubtitleOverlay';
import {
    SubtitlePlaybackDelegate,
    SubtitlePlaybackSyncer,
} from './SubtitlePlaybackSyncer';

function makeCue(
    id: number,
    startTime: number,
    endTime: number,
    rawText: string,
): SubtitleCue {
    return { id, startTime, endTime, rawText, transText: '', status: 'raw' };
}

class MockVideoElement {
    paused = false;
    seeking = false;
    playbackRate = 1.0;
    currentTime = 0;
    private listeners = new Map<string, Set<EventListener>>();

    addEventListener(type: string, listener: EventListener): void {
        if (!this.listeners.has(type)) {
            this.listeners.set(type, new Set());
        }
        this.listeners.get(type)!.add(listener);
    }

    removeEventListener(type: string, listener: EventListener): void {
        this.listeners.get(type)?.delete(listener);
    }

    emit(type: string): void {
        this.listeners.get(type)?.forEach((fn) => fn({ type } as Event));
    }

    listenerCount(type: string): number {
        return this.listeners.get(type)?.size ?? 0;
    }
}

function writeDatasetTiming(payload: PlaybackDatasetPayload): void {
    (
        globalThis.document.documentElement.dataset as Record<string, string>
    )[NCW_DATASET_SYNC_KEY] = JSON.stringify(payload);
}

describe('SubtitlePlaybackSyncer boundary & stall stability', () => {
    let nowMs = 1000;
    let cues: SubtitleCue[];
    let mockOverlay: {
        isVisible: boolean;
        showCues: ReturnType<typeof vi.fn>;
        hide: ReturnType<typeof vi.fn>;
    };
    let mockDelegate: SubtitlePlaybackDelegate;
    let syncer: SubtitlePlaybackSyncer;
    let video: MockVideoElement;

    beforeEach(() => {
        nowMs = 1000;
        vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
        vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        vi.stubGlobal('document', {
            documentElement: { dataset: {} },
            querySelector: vi.fn(() => null),
        });

        cues = [
            makeCue(1, 10.0, 12.0, '第一行台词'),
            makeCue(2, 12.0, 14.0, '第二行台词'),
            makeCue(3, 16.0, 18.0, '第三行台词'),
        ];

        mockOverlay = {
            isVisible: false,
            showCues: vi.fn(() => {
                mockOverlay.isVisible = true;
            }),
            hide: vi.fn(() => {
                mockOverlay.isVisible = false;
            }),
        };

        mockDelegate = {
            isContextValid: () => true,
            isAdPlaying: () => false,
            getCues: () => cues,
            getRawAsrCues: () => [],
            isAsrTrack: () => false,
            getTranslation: (id) => ({
                id,
                text: `译文${id}`,
                status: 'translated',
            }),
            checkCueStaleness: vi.fn(),
            onPipelineTick: vi.fn(),
            onSeeked: vi.fn(),
            getCurrentMovieId: () => 'ep-1',
            isLive: () => false,
        };

        syncer = new SubtitlePlaybackSyncer(
            mockOverlay as unknown as SubtitleOverlay,
            mockDelegate,
            () => ({ enabled: true }),
        );
        video = new MockVideoElement();
        syncer.attachVideo(video as unknown as HTMLVideoElement);
    });

    afterEach(() => {
        syncer.detachVideo();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    describe('findActiveCues half-open boundary semantics', () => {
        it('switches cleanly at touching cue boundaries without showing both cues', () => {
            expect(syncer.findActiveCues(11.999).map((c) => c.id)).toEqual([1]);
            expect(syncer.findActiveCues(12.0).map((c) => c.id)).toEqual([2]);
            expect(syncer.findActiveCues(12.001).map((c) => c.id)).toEqual([2]);
        });

        it('ends a cue cleanly at endTime when followed by a gap', () => {
            expect(syncer.findActiveCues(13.999).map((c) => c.id)).toEqual([2]);
            expect(syncer.findActiveCues(14.0).map((c) => c.id)).toEqual([]);
        });

        it('preserves simultaneous display for genuinely overlapping cues', () => {
            cues = [
                makeCue(1, 10.0, 13.0, '角色A'),
                makeCue(2, 12.0, 14.0, '角色B'),
            ];
            expect(syncer.findActiveCues(12.5).map((c) => c.id)).toEqual([1, 2]);
            expect(syncer.findActiveCues(13.0).map((c) => c.id)).toEqual([2]);
        });

        it('still matches zero-duration cues at their exact timestamp', () => {
            cues = [makeCue(1, 10.0, 10.0, '瞬时字幕')];
            expect(syncer.findActiveCues(10.0).map((c) => c.id)).toEqual([1]);
        });
    });

    describe('stall/buffering extrapolation & snap-back prevention', () => {
        it('freezes at baseTime when waiting/stalled event fires near a cue boundary', () => {
            writeDatasetTiming({
                movieId: 'ep-1',
                currentTime: 11.95,
                syncAt: 1000,
                isPaused: false,
                playbackRate: 1.0,
            });

            video.emit('waiting');
            nowMs = 1300;
            syncer.onTick();

            expect(mockOverlay.showCues).toHaveBeenCalledTimes(1);
            expect(mockOverlay.showCues.mock.calls[0][0][0].id).toBe(1);

            // Even as time keeps advancing while stalled, subtitle does not flip to cue 2
            nowMs = 1600;
            syncer.onTick();
            nowMs = 1900;
            syncer.onTick();
            expect(mockOverlay.showCues).toHaveBeenCalledTimes(1);
        });

        it('stops extrapolating and prevents alternating flicker when adapter refreshes identical baseTime during a stall', () => {
            // 1. Adapter reports 11.90s at t=1000ms
            writeDatasetTiming({
                movieId: 'ep-1',
                currentTime: 11.9,
                syncAt: 1000,
                isPaused: false,
                playbackRate: 1.0,
            });

            // 2. Extrapolates across 12.0s boundary (e.g. 12.20s at t=1300ms) -> shows cue 2
            nowMs = 1300;
            syncer.onTick();
            expect(mockOverlay.showCues).toHaveBeenCalledTimes(1);
            expect(mockOverlay.showCues.mock.calls[0][0][0].id).toBe(2);

            // 3. Adapter polls again at t=1500ms and baseTime is STILL 11.90s (video stalled!)
            //    Previously: delta = -0.30s bypassed -0.25s clamp, snapping back to cue 1, then oscillating forever.
            nowMs = 1500;
            writeDatasetTiming({
                movieId: 'ep-1',
                currentTime: 11.9,
                syncAt: 1500,
                isPaused: false,
                playbackRate: 1.0,
            });
            syncer.onTick();

            // 4. Subsequent ticks while still stalled must NOT re-render or flip back to cue 1
            nowMs = 1750;
            syncer.onTick();
            nowMs = 2000;
            writeDatasetTiming({
                movieId: 'ep-1',
                currentTime: 11.9,
                syncAt: 2000,
                isPaused: false,
                playbackRate: 1.0,
            });
            syncer.onTick();

            expect(mockOverlay.showCues).toHaveBeenCalledTimes(1);

            // 5. Playback resumes and advances to 16.20s -> stall clears and cue 3 displays
            nowMs = 2500;
            writeDatasetTiming({
                movieId: 'ep-1',
                currentTime: 16.2,
                syncAt: 2500,
                isPaused: false,
                playbackRate: 1.0,
            });
            syncer.onTick();

            expect(mockOverlay.showCues).toHaveBeenCalledTimes(2);
            expect(mockOverlay.showCues.mock.calls[1][0][0].id).toBe(3);
        });

        it('resets stall & time tracking cleanly on seeking/seeked backward', () => {
            writeDatasetTiming({
                movieId: 'ep-1',
                currentTime: 16.5,
                syncAt: 1000,
                isPaused: false,
                playbackRate: 1.0,
            });
            nowMs = 1000;
            syncer.onTick();
            expect(mockOverlay.showCues.mock.calls[0][0][0].id).toBe(3);

            video.emit('seeking');
            nowMs = 1100;
            writeDatasetTiming({
                movieId: 'ep-1',
                currentTime: 10.5,
                syncAt: 1100,
                isPaused: false,
                playbackRate: 1.0,
            });
            video.emit('seeked');

            expect(mockOverlay.showCues).toHaveBeenCalledTimes(2);
            expect(mockOverlay.showCues.mock.calls[1][0][0].id).toBe(1);
        });
    });

    describe('attachVideo / detachVideo listener lifecycle', () => {
        it('removes all registered video event listeners cleanly on detach', () => {
            const events = [
                'timeupdate',
                'seeking',
                'seeked',
                'play',
                'pause',
                'waiting',
                'stalled',
                'playing',
            ];
            for (const evt of events) {
                expect(video.listenerCount(evt)).toBe(1);
            }

            syncer.detachVideo();

            for (const evt of events) {
                expect(video.listenerCount(evt)).toBe(0);
            }
        });
    });
});
