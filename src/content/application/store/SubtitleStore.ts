import { SubtitleCue } from '@shared/domain/entities/Subtitle';
import { TranslationStatus } from '@shared/domain/entities/Translation';
import { Context } from '@shared/domain/entities/Context';
import { Logger } from '@shared/utils/logger';

export interface TranslationItem {
  readonly text: string;
  readonly status: TranslationStatus;
  readonly usedTerms?: Record<string, number>;
}

export class SubtitleStore {
  private readonly logger = new Logger('SubtitleStore');

  cues: SubtitleCue[] = [];
  readonly translationMap = new Map<number, TranslationItem>();
  readonly cueStateMap = new Map<number, TranslationStatus>();

  canonicalReviewIndex = 0;
  sessionEpoch = 0;
  lastCuesLoadedAt = 0;
  currentTrackHash = '';
  activeCueId: number | null = null;
  lastCueSig = '';

  getCueStatus(cueId: number): TranslationStatus {
    return this.cueStateMap.get(cueId) || 'untranslated';
  }

  isCueTranslated(cueId: number): boolean {
    const status = this.getCueStatus(cueId);
    const isTranslatedStatus =
      status === 'raw' ||
      status === 'pre_reviewing' ||
      status === 'pre_reviewed' ||
      status === 'reviewing' ||
      status === 'reviewed';
    return isTranslatedStatus && this.translationMap.has(cueId);
  }

  isCueReviewed(cueId: number): boolean {
    return this.getCueStatus(cueId) === 'reviewed';
  }

  setTranslation(
    cueId: number,
    text: string,
    status: TranslationStatus,
    usedTerms?: Record<string, number>,
  ): void {
    this.translationMap.set(cueId, { text, status, usedTerms });
    this.cueStateMap.set(cueId, status);
  }

  setCueStatus(cueId: number, status: TranslationStatus): void {
    this.cueStateMap.set(cueId, status);
    const existing = this.translationMap.get(cueId);
    if (existing) {
      this.translationMap.set(cueId, { ...existing, status });
    }
  }

  checkCueStaleness(cueId: number, context: Context): boolean {
    const trans = this.translationMap.get(cueId);
    if (!trans || !trans.usedTerms || Object.keys(trans.usedTerms).length === 0) {
      return false;
    }

    if (context.checkTermStaleness(trans.usedTerms)) {
      this.logger.info('SubtitleStore', `Cue #${cueId} uses stale terms:`, trans.usedTerms);
      this.markCueStaleWithLookahead(cueId, Object.keys(trans.usedTerms));
      return true;
    }
    return false;
  }

  markCueStaleWithLookahead(cueId: number, staleTermKeys: string[]): void {
    this.cueStateMap.set(cueId, 'stale');
    this.translationMap.delete(cueId);

    const cueIdx = this.cues.findIndex((c) => c.id === cueId);
    if (cueIdx < 0) return;

    const lookaheadLimit = Math.min(this.cues.length, cueIdx + 16);
    for (let j = cueIdx + 1; j < lookaheadLimit; j++) {
      const aheadCue = this.cues[j];
      const aheadTrans = this.translationMap.get(aheadCue.id);
      if (aheadTrans?.usedTerms && this.hasMatchingStaleTerm(aheadTrans.usedTerms, staleTermKeys)) {
        this.cueStateMap.set(aheadCue.id, 'stale');
        this.translationMap.delete(aheadCue.id);
      }
    }
  }

  checkStaleCues(
    effectiveTime: number,
    context: Context,
    findCueIndexAtTime: (time: number) => number,
  ): boolean {
    if (this.cues.length === 0) return false;
    const currentIdx = findCueIndexAtTime(effectiveTime);
    if (currentIdx < 0) return false;

    let hasInvalidatedActive = false;
    const windowEnd = Math.min(this.cues.length, currentIdx + 10);

    for (let i = currentIdx; i < windowEnd; i++) {
      const cue = this.cues[i];
      if (cue && this.checkCueStaleness(cue.id, context)) {
        if (i === currentIdx) hasInvalidatedActive = true;
      }
    }

    return hasInvalidatedActive;
  }

  isSameSubtitle(newCues: SubtitleCue[]): boolean {
    if (this.cues.length === 0 || newCues.length === 0) return false;
    if (this.cues.length !== newCues.length) return false;

    const mid = Math.floor(newCues.length / 2);
    const last = newCues.length - 1;
    return (
      this.cues[0]?.rawText === newCues[0]?.rawText &&
      this.cues[0]?.startTime === newCues[0]?.startTime &&
      this.cues[mid]?.rawText === newCues[mid]?.rawText &&
      this.cues[last]?.rawText === newCues[last]?.rawText
    );
  }

  loadCues(newCues: SubtitleCue[], epoch: number, trackHash = ''): void {
    this.sessionEpoch = epoch;
    this.lastCuesLoadedAt = epoch;
    this.currentTrackHash = trackHash;
    this.cues = newCues;
    this.clearTranslations();
  }

  clearTranslations(): void {
    this.translationMap.clear();
    this.cueStateMap.clear();
    this.canonicalReviewIndex = 0;
    this.activeCueId = null;
    this.lastCueSig = '';
  }

  clearCues(): void {
    this.sessionEpoch = Date.now();
    this.cues = [];
    this.currentTrackHash = '';
    this.clearTranslations();
  }

  private hasMatchingStaleTerm(
    usedTerms: Record<string, number>,
    staleKeys: string[],
  ): boolean {
    return staleKeys.some((termKey) => {
      const norm = termKey.toLowerCase();
      return usedTerms[norm] !== undefined;
    });
  }
}
