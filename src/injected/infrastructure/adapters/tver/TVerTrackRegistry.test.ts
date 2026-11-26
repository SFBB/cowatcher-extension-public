import { describe, expect, it } from 'vitest';
import { TVerTrackRegistry } from './TVerTrackRegistry';
import { TVerStreaksPlayer } from './TVerTypes';

const EP1_VTT = `WEBVTT

1
00:00:01.000 --> 00:00:03.000
第一集台词一

2
00:00:04.000 --> 00:00:06.000
第一集台词二

3
00:00:07.000 --> 00:00:09.000
第一集台词三
`;

const EP2_VTT = `WEBVTT

1
00:00:02.000 --> 00:00:04.000
第二集台词一

2
00:00:05.000 --> 00:00:07.000
第二集台词二

3
00:00:08.000 --> 00:00:10.000
第二集台词三
`;

const EP1_TTML = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml">
  <body>
    <div>
      <p begin="00:00:01.000" end="00:00:03.000">第一集台词一</p>
      <p begin="00:00:04.000" end="00:00:06.000">第一集台词二</p>
      <p begin="00:00:07.000" end="00:00:09.000">第一集台词三</p>
    </div>
  </body>
</tt>`;

describe('TVerTrackRegistry episode isolation & merge guard', () => {
    it('replaces instead of merging for non-live VOD tracks', () => {
        const registry = new TVerTrackRegistry();

        registry.mergeOrRegisterTrack(
            'ep2',
            'ja',
            { trackId: 't1', url: 'https://tver.jp/a.vtt', rawText: EP1_VTT, interceptedAt: 1000 },
            false,
        );

        const { detail, hasNewCues } = registry.mergeOrRegisterTrack(
            'ep2',
            'ja',
            { trackId: 't2', url: 'https://tver.jp/b.vtt', rawText: EP2_VTT, interceptedAt: 2000 },
            false,
        );

        expect(hasNewCues).toBe(true);
        expect(detail.rawText).toContain('第二集台词一');
        expect(detail.rawText).not.toContain('第一集台词一');
    });

    it('merges incremental cues only when allowMerge is true (live streams)', () => {
        const registry = new TVerTrackRegistry();

        registry.mergeOrRegisterTrack(
            'live1',
            'ja',
            { trackId: 'live', rawText: EP1_VTT, interceptedAt: 1000 },
            true,
        );

        const { detail, hasNewCues } = registry.mergeOrRegisterTrack(
            'live1',
            'ja',
            { trackId: 'live', rawText: EP2_VTT, interceptedAt: 2000 },
            true,
        );

        expect(hasNewCues).toBe(true);
        expect(detail.rawText).toContain('第一集台词一');
        expect(detail.rawText).toContain('第二集台词一');
    });

    it('returns undefined from getTrack (QUERY_SUBTITLE) while player TextTracks still hold previous episode cues, then resolves once ep2 arrives', async () => {
        const registry = new TVerTrackRegistry();

        registry.addInterceptedTrack(
            'https://cdn.tver.jp/sub/ep1.ttml',
            EP1_TTML,
            'ep1',
            'ja',
            false,
        );

        const stalePlayer = {
            textTracks: () => [
                {
                    kind: 'subtitles',
                    language: 'ja',
                    label: '日本語',
                    cues: [
                        { startTime: 1, endTime: 3, text: '第一集台词一' },
                        { startTime: 4, endTime: 6, text: '第一集台词二' },
                        { startTime: 7, endTime: 9, text: '第一集台词三' },
                    ],
                },
            ],
        } as unknown as TVerStreaksPlayer;

        const mockVideo = { readyState: 4 } as unknown as HTMLVideoElement;

        // First QUERY_SUBTITLE poll while player still has ep1's TextTrack -> must return undefined (keep polling), not ep1!
        const firstPoll = await registry.getTrack('ep2', 'ja', stalePlayer, mockVideo);
        expect(firstPoll).toBeUndefined();
        expect(registry.getCachedTrack('ep2')).toBeNull();

        // Multi-episode hop: ep3 also rejects ep1's leftover TextTrack
        const ep3Poll = await registry.getTrack('ep3', 'ja', stalePlayer, mockVideo);
        expect(ep3Poll).toBeUndefined();

        // Now ep2's real subtitle arrives
        const ep2Detail = registry.addInterceptedTrack(
            'https://cdn.tver.jp/sub/ep2.vtt',
            EP2_VTT,
            'ep2',
            'ja',
            false,
        );

        expect(ep2Detail?.rawText).toContain('第二集台词一');
        expect(ep2Detail?.rawText).not.toContain('第一集台词一');

        const resolvedPoll = await registry.getTrack('ep2', 'ja', stalePlayer, mockVideo);
        expect(resolvedPoll?.rawText).toContain('第二集台词一');
    });

    it('supports going back to rewatch ep1 without marking ep1 itself as stale', async () => {
        const registry = new TVerTrackRegistry();
        registry.addInterceptedTrack('https://cdn.tver.jp/sub/ep1.vtt', EP1_VTT, 'ep1', 'ja', false);
        registry.addInterceptedTrack('https://cdn.tver.jp/sub/ep2.vtt', EP2_VTT, 'ep2', 'ja', false);

        const ep2LeftoverPlayer = {
            textTracks: () => [
                {
                    kind: 'subtitles',
                    language: 'ja',
                    label: '日本語',
                    cues: [
                        { startTime: 2, endTime: 4, text: '第二集台词一' },
                        { startTime: 5, endTime: 7, text: '第二集台词二' },
                        { startTime: 8, endTime: 10, text: '第二集台词三' },
                    ],
                },
            ],
        } as unknown as TVerStreaksPlayer;

        // Rewatching ep1 hits ep1's own cache via getTrack
        const rewatch = await registry.getTrack('ep1', 'ja', ep2LeftoverPlayer, null);
        expect(rewatch?.rawText).toContain('第一集台词一');

        // And extracting ep2's leftover TextTrack while on ep1 is rejected, while ep1's own track is not
        expect(registry.isStaleForEpisode('ep1', EP2_VTT)).toBe(true);
        expect(registry.isStaleForEpisode('ep1', EP1_VTT)).toBe(false);
    });

    it('clears unknownTracks on episode change so stale tracks are not bound to the next episode', () => {
        const registry = new TVerTrackRegistry();
        registry.addInterceptedTrack('https://cdn.tver.jp/unknown.vtt', EP1_VTT, null, 'ja');
        registry.clearUnknownTracks();

        const resolved = registry.checkUnknownTracks('ep2');
        expect(resolved).toHaveLength(0);
    });
});
