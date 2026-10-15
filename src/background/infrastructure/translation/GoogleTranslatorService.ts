import { Logger } from '@shared/utils/logger';
import {
  ITranslatorService,
  TranslateBatchRequest,
  TranslateBatchResponse,
  ReviewBatchRequest,
  ReviewBatchResponse,
  MergeAsrCueItem,
  MergeAsrBatchRequest,
  MergeAsrBatchResponse,
  HealthCheckResult,
} from '../../domain/translation/ITranslatorService';

import { LanguageInfo } from '@shared/domain/value-objects/Language';
import { BrowserStorageFactory } from '@shared/infrastructure/storage/BrowserStorageFactory';
import { NCW_STORAGE_KEYS } from '@shared/domain/constants/StorageKeys';
import { ExtensionSettings } from '@shared/domain/constants/SettingsDefaults';

export class GoogleTranslatorService implements ITranslatorService {
  readonly providerId = 'google';

  // Rate-limiting queue state to prevent burst calls triggering 429
  private requestQueue: Promise<void> = Promise.resolve();
  private lastRequestTime = 0;
  private readonly minRequestIntervalMs = 500; // Minimum 500ms between calls to Google
  private backoffUntil = 0; // Timestamp until which requests must pause due to a 429

  private silenceThresholdMs = 600;
  private logger: Logger = new Logger('GoogleTranslatorService');

  async init(): Promise<void> {
    const storage = BrowserStorageFactory.getStorage();
    const res = await storage.get<Partial<ExtensionSettings>>([NCW_STORAGE_KEYS.SETTINGS]);
    const s = res[NCW_STORAGE_KEYS.SETTINGS];
    if (typeof s?.asrSilenceThresholdMs === 'number') {
      this.silenceThresholdMs = s.asrSilenceThresholdMs;
    }

    storage.onChanged((changes) => {
      const s = changes[NCW_STORAGE_KEYS.SETTINGS]?.newValue as Partial<ExtensionSettings> | undefined;
      if (typeof s?.asrSilenceThresholdMs === 'number') {
        this.silenceThresholdMs = s.asrSilenceThresholdMs;
      }
    });
  }

  private mapLanguageCode(lang?: LanguageInfo | 'auto'): string {
    if (!lang || lang === 'auto') return 'auto';
    return lang.code;
  }

  /**
   * Cleans ID markers (e.g., [643], [643]:, 【643】, 【643】：) and extraneous wrapper quotes
   */
  private cleanTranslationText(text: string): string {
    if (!text) return '';
    return (
      text
        // Strip leading brackets and IDs: [643]:, 【643】：, [643] -, 643., etc.
        .replace(/^(?:\[|【|\()\s*\d+\s*(?:\]|】|\))\s*[:：\-.]?\s*/, '')
        .replace(/^(\d+)\s*[:：\-.]\s*/, '')
        // Strip any residual [id] or 【id】 markers within text
        .replace(/(?:\[|【)\s*\d+\s*(?:\]|】)\s*[:：]?\s*/g, '')
        // Strip wrapping quotes
        .replace(/^["'“”](.*)["'“”]$/, '$1')
        .trim()
    );
  }

  /**
   * Robustly parses numbered subtitles from raw translated text.
   * Extracts text segments bounded by target ID markers (e.g. [81]:, 【81】：, 81., etc.).
   * If an ID marker is missing in the output, it is omitted rather than blindly guessed by index,
   * completely preventing downstream cue misalignment.
   */
  private parseNumberedSubtitles(
    text: string,
    targetIds: Set<number>,
    orderedItems: Array<{ id: number }>
  ): Record<number, string> {
    const resultMap: Record<number, string> = {};
    if (!text) return resultMap;

    // Pattern 1: Bracketed markers [123] or 【123】, preceded by start, newline, or whitespace
    // Pattern 2: Line starters: 123. or 123: or 123： or #123: at the beginning of a line
    const markerRegex =
      /(?:(?:^|\n|\s)(?:\[|【)\s*(\d+)\s*(?:\]|】)\s*[:：]?\s*|(?:^|\n)\s*(?:#)?\s*(\d+)\s*[\.:：]\s*)/g;
    const markers: Array<{ id: number; start: number; end: number }> = [];

    let match: RegExpExecArray | null;
    while ((match = markerRegex.exec(text)) !== null) {
      const idStr = match[1] || match[2];
      if (!idStr) continue;
      const id = parseInt(idStr, 10);
      if (targetIds.has(id)) {
        markers.push({
          id,
          start: match.index,
          end: match.index + match[0].length,
        });
      }
    }

    if (markers.length > 0) {
      markers.sort((a, b) => a.start - b.start);
      for (let i = 0; i < markers.length; i++) {
        const current = markers[i];
        const nextStart = i + 1 < markers.length ? markers[i + 1].start : text.length;
        const rawChunk = text.slice(current.end, nextStart).trim();
        if (rawChunk) {
          resultMap[current.id] = this.cleanTranslationText(rawChunk);
        }
      }
      return resultMap;
    }

    // Fallback ONLY when absolutely no markers were matched:
    const rawLines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(
        (l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('*') && !l.startsWith('---')
      );

    if (rawLines.length === orderedItems.length) {
      orderedItems.forEach((item, index) => {
        resultMap[item.id] = this.cleanTranslationText(rawLines[index]);
      });
    } else {
      this.logger.warn(
        'Translator',
        `Batch translation returned unformatted text without ID markers, and line count (${rawLines.length}) does not match items count (${orderedItems.length}). Discarding unverified batch to prevent misalignment.`
      );
    }

    return resultMap;
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('Aborted'));
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new Error('Aborted'));
        },
        { once: true }
      );
    });
  }

  /**
   * Enqueues an execution to ensure sequential requests with spacing and respect backoff
   */
  private async scheduleRequest<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const run = async (): Promise<T> => {
      if (signal?.aborted) throw new Error('Aborted');

      const now = Date.now();
      // If currently under 429 backoff cooldown, wait until cooldown ends
      if (this.backoffUntil > now) {
        const waitMs = this.backoffUntil - now;
        await this.sleep(waitMs, signal);
      }

      // Ensure minimal spacing between consecutive requests
      const elapsed = Date.now() - this.lastRequestTime;
      if (elapsed < this.minRequestIntervalMs) {
        await this.sleep(this.minRequestIntervalMs - elapsed, signal);
      }

      this.lastRequestTime = Date.now();
      return fn();
    };

    // Chain onto sequential queue
    const chained = this.requestQueue.then(run, run);
    this.requestQueue = chained.then(
      () => {},
      () => {}
    );
    return chained;
  }

  /**
   * Executes a single sub-batch network fetch with exponential backoff on 429
   */
  private async executeFetchWithRetry(
    payloadText: string,
    sl: string,
    tl: string,
    signal?: AbortSignal,
    maxRetries = 3
  ): Promise<any> {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(
      sl
    )}&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(payloadText)}`;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) throw new Error('Aborted');

      try {
        const res = await this.scheduleRequest(() => fetch(url, { method: 'GET', signal }), signal);

        if (res.status === 429) {
          // Calculate exponential backoff cooldown with jitter (1.5s, 3s, 6s)
          const delayMs = Math.round(1500 * Math.pow(2, attempt) + Math.random() * 500);
          this.backoffUntil = Math.max(this.backoffUntil, Date.now() + delayMs);
          this.logger.warn(
            'Translator',
            `429 Rate limited. Backing off for ${delayMs}ms (attempt ${attempt + 1}/${maxRetries + 1})...`
          );

          if (attempt === maxRetries) {
            throw new Error(
              `Google Translate HTTP 429 (Too Many Requests): Rate limit exceeded after ${maxRetries} retries`
            );
          }

          await this.sleep(delayMs, signal);
          continue;
        }

        if (!res.ok) {
          throw new Error(`Google Translate HTTP ${res.status}: ${res.statusText}`);
        }

        return await res.json();
      } catch (err: any) {
        if (err.name === 'AbortError' || signal?.aborted) {
          throw err;
        }
        if (attempt === maxRetries || (err.message && err.message.includes('429'))) {
          throw err;
        }
        // Brief retry wait for standard transient network errors
        await this.sleep(1000, signal);
      }
    }
  }

  async translateBatch(req: TranslateBatchRequest): Promise<TranslateBatchResponse> {
    const { items, targetLang, sourceLang = 'auto', signal } = req;
    if (!items || items.length === 0) {
      return { success: true, results: {} };
    }

    const sl = this.mapLanguageCode(sourceLang);
    const tl = this.mapLanguageCode(targetLang);

    try {
      // Split into smaller text chunks if total characters exceed safe query length (~1200 chars)
      const MAX_PAYLOAD_CHARS = 1200;
      const chunks: Array<typeof items> = [];
      let currentChunk: typeof items = [];
      let currentLen = 0;

      for (const item of items) {
        const text = item.rawText ?? '';
        const itemLen = text.length + 15;
        if (currentChunk.length > 0 && currentLen + itemLen > MAX_PAYLOAD_CHARS) {
          chunks.push(currentChunk);
          currentChunk = [item];
          currentLen = itemLen;
        } else {
          currentChunk.push(item);
          currentLen += itemLen;
        }
      }
      if (currentChunk.length > 0) {
        chunks.push(currentChunk);
      }

      const resultMap: Record<number, string> = {};

      for (const subBatch of chunks) {
        if (signal?.aborted) return { success: false, error: 'Aborted' };

        const joinedPayload = subBatch
          .map((it) => `[${it.id}]: ${(it.rawText ?? '').replace(/\r?\n/g, ' ')}`)
          .join('\n');

        const data = await this.executeFetchWithRetry(joinedPayload, sl, tl, signal);

        // Google Translate returns array of segments: [[["translated", "source", null, null, ...], ...], ...]
        let fullTranslatedText = '';
        if (Array.isArray(data) && Array.isArray(data[0])) {
          for (const segment of data[0]) {
            if (segment && typeof segment[0] === 'string') {
              fullTranslatedText += segment[0];
            }
          }
        }

        const targetIds = new Set(subBatch.map((it) => it.id));
        const subResultMap = this.parseNumberedSubtitles(fullTranslatedText, targetIds, subBatch);
        Object.assign(resultMap, subResultMap);
      }

      // Safety Guard: Validate that EVERY requested cue was translated with non-empty text
      const missingIds = items.filter((it) => !resultMap[it.id] || !resultMap[it.id].trim());
      if (missingIds.length > 0) {
        const errorMsg = `Safety Guard: Google Translate count mismatch (expected ${items.length} cues, but received ${Object.keys(resultMap).length} valid cues). Missing cue IDs: [${missingIds.map((m) => m.id).join(', ')}]. Discarding entire batch to trigger retry and prevent subtitle misalignment.`;
        this.logger.warn('Translator', errorMsg);
        return { success: false, error: errorMsg };
      }

      return { success: true, results: resultMap };
    } catch (err: any) {
      if (err.name === 'AbortError' || err.message === 'Aborted') {
        return { success: false, error: 'Aborted' };
      }
      this.logger.warn('Translation', err);
      return { success: false, error: err.message || 'Google Translate request failed' };
    }
  }

  /**
   * Supervisor review is a zero-latency pass-through for Google Translate
   */
  async reviewBatch(_req: ReviewBatchRequest): Promise<ReviewBatchResponse> {
    return {
      success: true,
      corrections: {},
    };
  }

  /**
   * Programmatic heuristic merging for ASR subtitle fragments
   */
  async mergeAsrBatch(req: MergeAsrBatchRequest): Promise<MergeAsrBatchResponse> {
    const { items } = req;
    if (!items || items.length === 0) return { success: true, mergedCues: [] };

    const silenceSec = this.silenceThresholdMs / 1000;
    const mergedCues: MergeAsrCueItem[] = [];

    let currentGroup: MergeAsrCueItem[] = [];

    const flushGroup = () => {
      if (currentGroup.length === 0) return;
      const first = currentGroup[0];
      const last = currentGroup[currentGroup.length - 1];
      const combinedText = currentGroup
        .map((it) => it.rawText.trim())
        .filter(Boolean)
        .join(' ');

      if (combinedText.length > 0) {
        mergedCues.push({
          id: first.id,
          startTime: first.startTime,
          endTime: last.endTime,
          rawText: combinedText,
        });
      }
      currentGroup = [];
    };

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      currentGroup.push(item);

      const next = items[i + 1];
      const hasSilenceBreak = next ? next.startTime - item.endTime >= silenceSec : true;
      const text = item.rawText.trim();
      const hasPunctuationEnd = /[.!?。！？\n]$/.test(text);
      const totalWords = currentGroup.reduce(
        (acc, it) => acc + it.rawText.trim().split(/\s+/).length,
        0
      );

      if (hasSilenceBreak || hasPunctuationEnd || totalWords >= 25 || !next) {
        flushGroup();
      }
    }

    return { success: true, mergedCues };
  }

  async checkHealth(): Promise<HealthCheckResult> {
    try {
      const testUrl =
        'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=hello';
      const res = await fetch(testUrl, { method: 'GET' });
      if (res.ok) {
        return { ok: true, message: 'Google Translate endpoint reachable' };
      }
      return { ok: false, message: `Google Translate status: ${res.status}` };
    } catch (e: any) {
      return { ok: false, message: e.message || 'Network error reaching Google Translate' };
    }
  }
}
