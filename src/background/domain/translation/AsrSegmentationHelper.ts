import { MergeAsrCueItem } from '@shared/domain/entities/Subtitle';
import { Logger } from '@shared/utils/logger';

export class AsrSegmentationHelper {
  private static readonly logger = new Logger('AsrSegmentationHelper');

  /**
   * Maximum duration for a single merged subtitle cue in seconds.
   * Standard subtitles should rarely exceed 4.5-5.0 seconds.
   */
  public static readonly MAX_DURATION_SEC = 5.0;

  /**
   * Maximum word count for Latin / spaced script subtitle units.
   */
  public static readonly MAX_WORDS = 12;

  /**
   * Maximum character count for CJK (Chinese, Japanese, Korean) subtitle units.
   */
  public static readonly MAX_CJK_CHARS = 22;

  /**
   * Hard silence break in seconds: any gap >= this threshold ALWAYS ends the cue.
   */
  public static readonly HARD_SILENCE_SEC = 0.5;

  /**
   * Soft silence break in seconds: ends cue if already has minimum content.
   */
  public static readonly SOFT_SILENCE_SEC = 0.35;

  /**
   * Helper to count CJK characters in text.
   */
  public static countCjk(text: string): number {
    const matches = text.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g);
    return matches ? matches.length : 0;
  }

  /**
   * Helper to count words (spaced) in text.
   */
  public static countWords(text: string): number {
    const trimmed = text.trim();
    if (!trimmed) return 0;
    return trimmed.split(/\s+/).length;
  }

  /**
   * Programmatic heuristic merging for ASR subtitle fragments.
   */
  public static algorithmicMerge(
    items: MergeAsrCueItem[],
    silenceThresholdMs = 450,
    logger?: Logger
  ): MergeAsrCueItem[] {
    const log = logger || this.logger;
    if (!items || items.length === 0) return [];

    const silenceSec = Math.min(Math.max(silenceThresholdMs / 1000, 0.3), this.HARD_SILENCE_SEC);
    log.info(
      'ASR-Merge',
      `[Algorithmic] Processing ${items.length} raw ASR fragments [${items[0].id}..${items[items.length - 1].id}] (${items[0].startTime.toFixed(2)}s - ${items[items.length - 1].endTime.toFixed(2)}s, silenceThresh=${silenceSec}s):`
    );
    items.forEach((it) => {
      log.info(
        'ASR-Merge',
        `  📋 Input Fragment #${it.id} [${it.startTime.toFixed(2)}s - ${it.endTime.toFixed(2)}s, dur=${(it.endTime - it.startTime).toFixed(2)}s]: "${it.rawText}"`
      );
    });

    const mergedCues: MergeAsrCueItem[] = [];
    let currentGroup: MergeAsrCueItem[] = [];

    const flushGroup = (reason: string) => {
      if (currentGroup.length === 0) return;
      const first = currentGroup[0];
      const last = currentGroup[currentGroup.length - 1];
      const combinedText = currentGroup
        .map((it) => it.rawText.trim())
        .filter(Boolean)
        .join(' ');

      if (combinedText.length > 0) {
        const cue: MergeAsrCueItem = {
          id: first.id,
          startTime: first.startTime,
          endTime: last.endTime,
          rawText: combinedText,
        };
        mergedCues.push(cue);

        const dur = cue.endTime - cue.startTime;
        const words = this.countWords(combinedText);
        const cjk = this.countCjk(combinedText);
        log.info(
          'ASR-Merge',
          `  🎯 Merged Sentence #${cue.id} [${cue.startTime.toFixed(2)}s - ${cue.endTime.toFixed(2)}s, dur=${dur.toFixed(2)}s, words=${words}, cjk=${cjk}]: "${combinedText}" (from #${first.id}..#${last.id}, reason: ${reason})`
        );
      }
      currentGroup = [];
    };

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      currentGroup.push(item);

      const next = items[i + 1];
      const groupStart = currentGroup[0].startTime;
      const currentDuration = item.endTime - groupStart;
      const combinedText = currentGroup.map((it) => it.rawText.trim()).join(' ');
      const wordsInGroup = this.countWords(combinedText);
      const cjkInGroup = this.countCjk(combinedText);

      const gapToNext = next ? next.startTime - item.endTime : 0;
      const nextDuration = next ? next.endTime - groupStart : currentDuration;

      // Decision rules
      if (!next) {
        flushGroup('end_of_batch');
        continue;
      }

      // 1. Hard silence break
      if (gapToNext >= silenceSec || gapToNext >= this.HARD_SILENCE_SEC) {
        flushGroup(`silence_gap(${gapToNext.toFixed(2)}s)`);
        continue;
      }

      // 2. Soft silence break with sufficient speech content
      if (
        gapToNext >= this.SOFT_SILENCE_SEC &&
        (wordsInGroup >= 4 || cjkInGroup >= 8 || currentDuration >= 1.8)
      ) {
        flushGroup(`soft_pause(${gapToNext.toFixed(2)}s)`);
        continue;
      }

      // 3. Maximum duration limit (prevent 6-10 second run-on sentences)
      if (currentDuration >= 4.5 || nextDuration > this.MAX_DURATION_SEC) {
        flushGroup(`max_duration(${currentDuration.toFixed(2)}s)`);
        continue;
      }

      // 4. Maximum word / CJK length limit
      if (wordsInGroup >= this.MAX_WORDS) {
        flushGroup(`max_words(${wordsInGroup})`);
        continue;
      }
      if (cjkInGroup >= this.MAX_CJK_CHARS) {
        flushGroup(`max_cjk_chars(${cjkInGroup})`);
        continue;
      }

      // 5. Terminal punctuation
      const text = item.rawText.trim();
      if (/[.!?。！？\n]$/.test(text)) {
        flushGroup('terminal_punctuation');
        continue;
      }

      // 6. Comma clause break if group already has decent length
      if (
        /[,;，；、]$/.test(text) &&
        (wordsInGroup >= 6 || cjkInGroup >= 12 || currentDuration >= 2.2)
      ) {
        flushGroup('comma_pause');
        continue;
      }

      // 7. Conjunction start on next word if group already has decent length
      const nextText = next.rawText.trim();
      const startsConjunction =
        /^(?:and|but|so|because|although|however|which|who|where|when|then|or|if|whereas|while)\b/i.test(
          nextText
        );
      if (
        startsConjunction &&
        (wordsInGroup >= 6 || cjkInGroup >= 12 || currentDuration >= 2.0)
      ) {
        flushGroup(`conjunction_before("${nextText.slice(0, 10)}")`);
        continue;
      }
    }

    // Snap contiguous gaps between adjacent cues up to 3.5s to prevent premature disappearance
    return this.snapContiguousCues(mergedCues, 3.5, log);
  }

  /**
   * Snaps small gaps (<= maxGapSec) between adjacent cues so playback transitions seamlessly.
   */
  public static snapContiguousCues(
    cues: MergeAsrCueItem[],
    maxGapSec = 3.5,
    logger?: Logger
  ): MergeAsrCueItem[] {
    if (!cues || cues.length < 2) return cues;
    const log = logger || this.logger;

    for (let i = 0; i < cues.length - 1; i++) {
      const current = cues[i];
      const next = cues[i + 1];

      // 1. Resolve overlapping cues: if current cue extends past next start, clamp current.endTime to next.startTime
      if (current.endTime > next.startTime && next.startTime > current.startTime) {
        log.info(
          'ASR-Merge',
          `  [Overlap] Clamped overlapping cue #${current.id} to next cue #${next.id} start: ${current.endTime.toFixed(2)}s -> ${next.startTime.toFixed(2)}s`
        );
        current.endTime = next.startTime;
      }

      // 2. Snap small pause gaps
      const gap = next.startTime - current.endTime;
      if (gap > 0 && gap <= maxGapSec) {
        log.info(
          'ASR-Merge',
          `  [Snap] Bridged pause gap (${gap.toFixed(2)}s) between cue #${current.id} and #${next.id}: extended endTime ${current.endTime.toFixed(2)}s -> ${next.startTime.toFixed(2)}s`
        );
        current.endTime = next.startTime;
      }
    }

    return cues;
  }

  /**
   * Post-processes LLM-produced range segments to enforce strict duration & word limits.
   */
  public static postProcessLlmRanges(
    ranges: Array<[number | string, number | string]>,
    items: MergeAsrCueItem[],
    silenceThresholdMs = 450,
    logger?: Logger
  ): MergeAsrCueItem[] {
    const log = logger || this.logger;
    log.info(
      'ASR-Merge',
      `[LLM Post-Process] Processing ${items.length} raw fragments [${items[0]?.id}..${items[items.length - 1]?.id}] mapped into ${ranges.length} LLM ranges:`
    );
    items.forEach((it) => {
      log.info(
        'ASR-Merge',
        `  📋 Input Fragment #${it.id} [${it.startTime.toFixed(2)}s - ${it.endTime.toFixed(2)}s]: "${it.rawText}"`
      );
    });

    const itemMap = new Map<number, MergeAsrCueItem>();
    items.forEach((it) => itemMap.set(it.id, it));

    const finalCues: MergeAsrCueItem[] = [];

    for (const r of ranges) {
      if (!Array.isArray(r) || r.length < 2) continue;
      const startId = parseInt(String(r[0]), 10);
      const endId = parseInt(String(r[1]), 10);
      if (isNaN(startId) || isNaN(endId) || startId > endId) continue;

      const group: MergeAsrCueItem[] = [];
      for (let id = startId; id <= endId; id++) {
        const it = itemMap.get(id);
        if (it) group.push(it);
      }
      if (group.length === 0) continue;

      const first = group[0];
      const last = group[group.length - 1];
      const duration = last.endTime - first.startTime;
      const combinedText = group
        .map((it) => it.rawText.trim())
        .filter(Boolean)
        .join(' ');
      const words = this.countWords(combinedText);
      const cjk = this.countCjk(combinedText);

      // Guard: if LLM grouped an oversized range (> 5.5s or > 14 words or > 26 CJK chars),
      // split it algorithmically into smaller readable cues!
      if (duration > 5.5 || words > 14 || cjk > 26) {
        log.info(
          'ASR-Merge',
          `[LLM Post-Process] Splitting oversized LLM range [${startId}..${endId}] (dur=${duration.toFixed(2)}s, words=${words}, cjk=${cjk}) into balanced sub-cues...`
        );
        const subCues = this.algorithmicMerge(group, silenceThresholdMs, log);
        finalCues.push(...subCues);
      } else {
        finalCues.push({
          id: first.id,
          startTime: first.startTime,
          endTime: last.endTime,
          rawText: combinedText,
        });
        log.info(
          'ASR-Merge',
          `  🎯 LLM Merged Sentence #${first.id} [${first.startTime.toFixed(2)}s - ${last.endTime.toFixed(2)}s, dur=${duration.toFixed(2)}s, words=${words}]: "${combinedText}" (from #${startId}..#${endId})`
        );
      }
    }

    return this.snapContiguousCues(finalCues, 3.5, log);
  }
}
