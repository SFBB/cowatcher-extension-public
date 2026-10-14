import { SubtitleCue } from '@shared/domain/entities/Subtitle';
import { SubtitleCueData } from '../adapters/IStreamingAdapter';

export interface AlignmentResult {
  alignedMap: Map<number, string>; // cue.id -> matched native translated text
  matchCoverage: number; // percentage of source cues that found a match (0.0 to 1.0)
  totalMatched: number;
  totalSource: number;
}

/**
 * Domain Service for aligning native target subtitle tracks to primary source subtitle tracks.
 * Handles timeline discrepancies, interval overlap (IoU), and timing tolerances.
 */
export class SubtitleAlignmentService {
  /**
   * Aligns native target subtitle cues with source cues based on interval overlap
   * with configurable timing tolerance (default 0.35s).
   */
  static align(
    sourceCues: SubtitleCue[],
    targetCues: SubtitleCueData[],
    toleranceSeconds = 0.35
  ): AlignmentResult {
    if (!sourceCues || sourceCues.length === 0 || !targetCues || targetCues.length === 0) {
      return {
        alignedMap: new Map(),
        matchCoverage: 0,
        totalMatched: 0,
        totalSource: sourceCues ? sourceCues.length : 0,
      };
    }

    const alignedMap = new Map<number, string>();
    let totalMatched = 0;

    // Sort target track chronologically
    const sortedTargets = [...targetCues].sort((a, b) => a.start - b.start);

    for (const src of sourceCues) {
      const srcStart = src.startTime - toleranceSeconds;
      const srcEnd = src.endTime + toleranceSeconds;

      // Find all target cues that overlap with this source cue
      const overlaps: Array<{ cue: SubtitleCueData; overlapDur: number }> = [];

      for (const tgt of sortedTargets) {
        // Fast prune if target starts way after this source cue
        if (tgt.start > srcEnd + 1.5) break;
        // Fast prune if target ended way before this source cue
        if (tgt.end < srcStart - 1.5) continue;

        const overlapStart = Math.max(src.startTime, tgt.start);
        const overlapEnd = Math.min(src.endTime, tgt.end);
        const overlapDur = overlapEnd - overlapStart;

        // Either actual temporal overlap or within timing tolerance window
        if (overlapDur > 0) {
          overlaps.push({ cue: tgt, overlapDur });
        } else {
          // Check proximity tolerance (e.g. official translation was slightly early or late)
          const dist = Math.min(
            Math.abs(src.startTime - tgt.start),
            Math.abs(src.endTime - tgt.end)
          );
          if (dist <= toleranceSeconds) {
            overlaps.push({ cue: tgt, overlapDur: 0.1 });
          }
        }
      }

      if (overlaps.length > 0) {
        // Collect and concatenate texts in chronological order
        const texts: string[] = [];
        const seenTexts = new Set<string>();

        overlaps.forEach((item) => {
          const clean = item.cue.text.trim();
          if (clean && !seenTexts.has(clean)) {
            seenTexts.add(clean);
            texts.push(clean);
          }
        });

        if (texts.length > 0) {
          alignedMap.set(src.id, texts.join(' '));
          totalMatched++;
        }
      }
    }

    const matchCoverage = sourceCues.length > 0 ? totalMatched / sourceCues.length : 0;

    return {
      alignedMap,
      matchCoverage,
      totalMatched,
      totalSource: sourceCues.length,
    };
  }
}
