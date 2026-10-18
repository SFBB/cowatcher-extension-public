import { SubtitleCueData } from '@content/domain/adapters/IStreamingAdapter';

/**
 * Dedicated YouTube Subtitle Parser.
 * Handles YouTube JSON3 format (wireMagic: "pb3") and timedtext XML formats (<timedtext>, <p t=".." d="..">, <transcript>).
 * Encapsulates all YouTube-specific cue processing, HTML entity decoding, ASR word segmentation,
 * and gap snapping without polluting generic parser utilities.
 */
export class YouTubeSubtitleParser {
  /**
   * Parse raw YouTube subtitle text (JSON3 or XML) into normalized SubtitleCueData array
   */
  static parse(raw: string): SubtitleCueData[] {
    if (!raw || typeof raw !== 'string') return [];

    const trimmed = raw.trim();
    if (trimmed.startsWith('{') && (trimmed.includes('"events"') || trimmed.includes('"wireMagic"'))) {
      return YouTubeSubtitleParser.parseJson3(trimmed);
    } else {
      return YouTubeSubtitleParser.parseXml(trimmed);
    }
  }

  /**
   * Parse YouTube JSON3 timedtext format ({ wireMagic: "pb3", events: [...] })
   */
  static parseJson3(jsonStr: string): SubtitleCueData[] {
    const cues: SubtitleCueData[] = [];
    try {
      const data = JSON.parse(jsonStr);
      if (!data || !Array.isArray(data.events)) return [];

      let cueId = 1;
      for (let eIdx = 0; eIdx < data.events.length; eIdx++) {
        const ev = data.events[eIdx];
        if (!ev || typeof ev.tStartMs !== 'number') continue;
        if (!ev.segs || !Array.isArray(ev.segs) || ev.segs.length === 0) continue;

        // Filter valid segments with string content (preserving spaces between words)
        const validSegs: Array<{ text: string; offsetMs: number }> = ev.segs
          .filter((s: any) => s && typeof s.utf8 === 'string' && s.utf8.length > 0)
          .map((s: any) => ({
            text: s.utf8,
            offsetMs: typeof s.tOffsetMs === 'number' ? s.tOffsetMs : 0,
          }));

        if (validSegs.length === 0) continue;

        const startSec = ev.tStartMs / 1000;
        const nominalDurMs = typeof ev.dDurationMs === 'number' ? ev.dDurationMs : 2000;

        // Calculate true end based on the offset of the last segment + speech duration
        const lastSeg = validSegs[validSegs.length - 1];
        const maxOffsetMs = Math.max(...validSegs.map((s) => s.offsetMs), 0);
        const lastWordDurMs = Math.max(1200, Math.min(3000, lastSeg.text.trim().length * 250));
        const trueEndMs =
          maxOffsetMs > 0 ? ev.tStartMs + maxOffsetMs + lastWordDurMs : ev.tStartMs + nominalDurMs;
        const eventEndSec = Math.max(ev.tStartMs + nominalDurMs, trueEndMs) / 1000;

        // ASR mode: word-level timing offsets are present
        if (maxOffsetMs > 0 && validSegs.length > 1) {
          let currentSentenceSegs: Array<{ text: string; offsetMs: number }> = [];

          for (let sIdx = 0; sIdx < validSegs.length; sIdx++) {
            const seg = validSegs[sIdx];
            currentSentenceSegs.push(seg);

            const isLast = sIdx === validSegs.length - 1;
            const nextSeg = !isLast ? validSegs[sIdx + 1] : null;
            const textSoFar = currentSentenceSegs.map((s) => s.text).join('').trim();
            const endsWithPunct = /[。！？.!?\n]$/.test(seg.text.trim());
            const hasPause = nextSeg && nextSeg.offsetMs - seg.offsetMs >= 500;
            const isLong = textSoFar.length >= 22;

            if (isLast || (endsWithPunct && nextSeg) || (hasPause && isLong && nextSeg)) {
              const cueStart = (ev.tStartMs + currentSentenceSegs[0].offsetMs) / 1000;
              const cueEnd = nextSeg ? (ev.tStartMs + nextSeg.offsetMs) / 1000 : eventEndSec;
              const cueText = YouTubeSubtitleParser.decodeHtmlEntities(
                currentSentenceSegs
                  .map((s) => s.text)
                  .join('')
                  .replace(/\n+/g, ' ')
                  .trim()
              );

              if (cueText) {
                cues.push({
                  id: cueId++,
                  start: cueStart,
                  end: Math.max(cueStart + 0.8, cueEnd),
                  text: cueText,
                  position: 'bottom',
                });
              }
              currentSentenceSegs = [];
            }
          }
        } else {
          // Normal author-created subtitle: keep author cue intact without destructive sentence-splitting
          const text = YouTubeSubtitleParser.decodeHtmlEntities(
            validSegs
              .map((s) => s.text)
              .join('')
              .replace(/\n+/g, ' ')
              .trim()
          );
          if (text) {
            const minReadingDur = Math.max(nominalDurMs / 1000, Math.min(15.0, text.length / 4.5));
            const endSec = Math.max(eventEndSec, startSec + minReadingDur);

            cues.push({
              id: cueId++,
              start: startSec,
              end: endSec,
              text,
              position: 'bottom',
            });
          }
        }
      }
    } catch {
      // Ignore JSON parse errors
    }

    return YouTubeSubtitleParser.normalizeAndSnapGaps(cues);
  }

  /**
   * Parse YouTube timedtext XML format (<timedtext>, <p t=".." d="..">, or <transcript><text start="..">)
   */
  static parseXml(xmlStr: string): SubtitleCueData[] {
    const cues: SubtitleCueData[] = [];

    // 1. Format 3 / Format 2: <p t="1200" d="3400"> (with optional <s> tags)
    if (/<p\s+t="\d+"/i.test(xmlStr)) {
      const pRegex = /<p\s+t="(\d+)"(?:\s+d="(\d+)")?[^>]*>([\s\S]*?)<\/p>/gi;
      let match: RegExpExecArray | null;
      let id = 1;
      while ((match = pRegex.exec(xmlStr)) !== null) {
        const startMs = parseInt(match[1], 10);
        const durMs = match[2] ? parseInt(match[2], 10) : 2000;
        const innerContent = match[3];

        // Parse internal <s> tags if present (word-level timing)
        const sRegex = /<s(?:\s+[^>]*?)?(?:\s+t="(\d+)")?[^>]*>([\s\S]*?)<\/s>/gi;
        let sMatch: RegExpExecArray | null;
        const segs: Array<{ text: string; offsetMs: number }> = [];
        while ((sMatch = sRegex.exec(innerContent)) !== null) {
          const offsetMs = sMatch[1] ? parseInt(sMatch[1], 10) : 0;
          const sText = YouTubeSubtitleParser.decodeHtmlEntities(
            sMatch[2].replace(/<[^>]+>/g, '')
          ).trim();
          if (sText) {
            segs.push({ text: sText, offsetMs });
          }
        }

        const maxOffsetMs = segs.length > 0 ? Math.max(...segs.map((s) => s.offsetMs), 0) : 0;
        const lastWordDurMs =
          segs.length > 0
            ? Math.max(1200, Math.min(3000, segs[segs.length - 1].text.length * 250))
            : 1500;
        const trueEndMs = maxOffsetMs > 0 ? startMs + maxOffsetMs + lastWordDurMs : startMs + durMs;
        const eventEndSec = Math.max(startMs + durMs, trueEndMs) / 1000;

        if (segs.length > 1 && maxOffsetMs > 0) {
          let currentSentenceSegs: Array<{ text: string; offsetMs: number }> = [];
          for (let sIdx = 0; sIdx < segs.length; sIdx++) {
            const seg = segs[sIdx];
            currentSentenceSegs.push(seg);

            const isLast = sIdx === segs.length - 1;
            const nextSeg = !isLast ? segs[sIdx + 1] : null;
            const textSoFar = currentSentenceSegs.map((s) => s.text).join('').trim();
            const endsWithPunct = /[。！？.!?\n]$/.test(seg.text.trim());
            const hasPause = nextSeg && nextSeg.offsetMs - seg.offsetMs >= 500;
            const isLong = textSoFar.length >= 22;

            if (isLast || (endsWithPunct && nextSeg) || (hasPause && isLong && nextSeg)) {
              const cueStart = (startMs + currentSentenceSegs[0].offsetMs) / 1000;
              const cueEnd = nextSeg ? (startMs + nextSeg.offsetMs) / 1000 : eventEndSec;
              const cueText = YouTubeSubtitleParser.decodeHtmlEntities(
                currentSentenceSegs
                  .map((s) => s.text)
                  .join('')
                  .replace(/\n+/g, ' ')
                  .trim()
              );

              if (cueText) {
                cues.push({
                  id: id++,
                  start: cueStart,
                  end: Math.max(cueStart + 0.8, cueEnd),
                  text: cueText,
                  position: 'bottom',
                });
              }
              currentSentenceSegs = [];
            }
          }
        } else {
          // Normal author-created subtitle: keep author cue intact without destructive sentence-splitting
          const rawText = innerContent.replace(/<[^>]+>/g, '').replace(/\n+/g, ' ');
          const text = YouTubeSubtitleParser.decodeHtmlEntities(rawText).trim();
          if (text) {
            const minReadingDur = Math.max(durMs / 1000, Math.min(15.0, text.length / 4.5));
            const startSec = startMs / 1000;
            const endSec = Math.max(eventEndSec, startSec + minReadingDur);

            cues.push({
              id: id++,
              start: startSec,
              end: endSec,
              text,
              position: 'bottom',
            });
          }
        }
      }
      return YouTubeSubtitleParser.normalizeAndSnapGaps(cues);
    }

    // 2. Format 1: <text start="1.23" dur="4.56"> (transcript format in seconds)
    const textRegex = /<text\s+start="([\d.]+)"(?:\s+dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/gi;
    let match: RegExpExecArray | null;
    let id = 1;
    while ((match = textRegex.exec(xmlStr)) !== null) {
      const start = parseFloat(match[1]);
      const dur = match[2] ? parseFloat(match[2]) : 2.0;
      const rawText = match[3].replace(/<[^>]+>/g, '').replace(/\n+/g, ' ');
      const text = YouTubeSubtitleParser.decodeHtmlEntities(rawText).trim();
      if (text) {
        const minReadingDur = Math.max(dur, Math.min(15.0, text.length / 4.5));
        const end = start + minReadingDur;
        cues.push({
          id: id++,
          start,
          end,
          text,
          position: 'bottom',
        });
      }
    }

    return YouTubeSubtitleParser.normalizeAndSnapGaps(cues);
  }

  private static normalizeAndSnapGaps(cues: SubtitleCueData[]): SubtitleCueData[] {
    if (cues.length === 0) return cues;
    cues.sort((a, b) => a.start - b.start);
    for (let i = 0; i < cues.length - 1; i++) {
      const curr = cues[i];
      const next = cues[i + 1];

      // 1. Resolve overlapping cues
      if (curr.end > next.start && next.start > curr.start) {
        curr.end = next.start;
      }

      // 2. Gap snapping: bridge natural speaking pauses <= 3.5s
      const gap = next.start - curr.end;
      if (gap > 0 && gap <= 3.5) {
        curr.end = next.start;
      }
    }
    return cues;
  }

  private static decodeHtmlEntities(str: string): string {
    return (str || '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
}
