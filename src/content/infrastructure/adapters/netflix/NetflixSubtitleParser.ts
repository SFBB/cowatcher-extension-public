import { SubtitleCueData } from '@content/domain/adapters/IStreamingAdapter';
import { SubtitleParser } from '@content/application/utils/parser';

/**
 * Dedicated Netflix Subtitle Parser.
 * Handles Netflix TTML / DFXP XML and WebVTT subtitle payloads.
 */
export class NetflixSubtitleParser {
    /**
     * Parse raw Netflix subtitle string into normalized SubtitleCueData array
     */
    static parse(raw: string): SubtitleCueData[] {
        if (!raw || typeof raw !== 'string') return [];

        const trimmed = raw.trim();
        if (trimmed.startsWith('WEBVTT') || trimmed.includes('\nWEBVTT')) {
            return SubtitleParser.parseVTT(trimmed);
        } else {
            return SubtitleParser.parseTTML(trimmed);
        }
    }
}
