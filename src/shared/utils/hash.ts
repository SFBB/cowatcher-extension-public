import { SubtitleCue } from '@shared/domain/entities/Subtitle';

export type CueItemForHash = SubtitleCue;

/**
 * Computes a robust hash representation of a subtitle track.
 * Uses Web Crypto SHA-256 where available, falling back to 64-bit FNV-1a.
 */
export async function computeTrackHash(cues: CueItemForHash[]): Promise<string> {
  if (!Array.isArray(cues) || cues.length === 0) return '';
  try {
    const summary = cues
      .map((c) => {
        const text = (c.rawText ?? '').trim();
        return `${c.id}:${Math.round((c.startTime || 0) * 1000)}:${text}`;
      })
      .join('\n');

    if (typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.digest) {
      const encoder = new TextEncoder();
      const data = encoder.encode(summary);
      const buf = await crypto.subtle.digest('SHA-256', data);
      const arr = Array.from(new Uint8Array(buf));
      return arr
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
        .slice(0, 24);
    }
  } catch (_e) {
    // Fallback
  }

  return computeFnv64(cues);
}

/**
 * 64-bit FNV-1a hash algorithm fallback.
 */
export function computeFnv64(cues: CueItemForHash[]): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < cues.length; i++) {
    const text = cues[i].rawText ?? '';
    const str = `${cues[i].id}:${cues[i].startTime}:${text}`;
    for (let j = 0; j < str.length; j++) {
      const code = str.charCodeAt(j);
      h1 = Math.imul(h1 ^ code, 0x01000193);
      h2 = Math.imul(h2 ^ (code >>> 2), 0x01000193);
    }
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}
