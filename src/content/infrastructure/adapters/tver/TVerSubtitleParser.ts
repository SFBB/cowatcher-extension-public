import { SubtitleCueData } from '@content/domain/adapters/IStreamingAdapter';
import { SubtitleParser } from '@content/application/utils/parser';

/**
 * Dedicated TVer Subtitle Parser.
 * Handles TVer TTML / DFXP XML (from Brightcove / StreaksPlayer) and WebVTT subtitle payloads.
 */
export class TVerSubtitleParser {
  /**
   * Parse raw TVer subtitle string into normalized SubtitleCueData array
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
