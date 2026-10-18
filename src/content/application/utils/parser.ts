/**
 * Subtitle Parser
 * Supports TTML / DFXP XML
 */
export interface ParsedCue {
  id: number;
  start: number;
  end: number;
  text: string;
  position?: 'bottom' | 'top' | 'left-vertical' | 'right-vertical';
}

export class SubtitleParser {
  /**
   * Parse raw subtitle string into normalized array of cues
   */
  static parse(raw: string): ParsedCue[] {
    if (!raw || typeof raw !== 'string') return [];

    const trimmed = raw.trim();
    if (trimmed.startsWith('WEBVTT') || trimmed.includes('\nWEBVTT')) {
      return SubtitleParser.parseVTT(trimmed);
    } else {
      return SubtitleParser.parseTTML(trimmed);
    }
  }

  /**
   * Detect source language from raw subtitle text or parsed cues
   */
  static detectLanguage(
    rawText: string = '',
    cues: Array<{ text?: string; rawText?: string }> = []
  ): string {
    if (typeof rawText === 'string') {
      const xmlLangMatch = rawText.match(/xml:lang=["']([^"']+)["']/i);
      if (xmlLangMatch && xmlLangMatch[1]) {
        return xmlLangMatch[1].trim();
      }
      const vttLangMatch = rawText.match(/Language:\s*([a-zA-Z-]+)/i);
      if (vttLangMatch && vttLangMatch[1]) {
        return vttLangMatch[1].trim();
      }
    }
    const sample =
      Array.isArray(cues) && cues.length > 0
        ? cues
            .slice(0, 25)
            .map((c) => c.text || c.rawText || '')
            .join(' ')
        : typeof rawText === 'string'
          ? rawText.slice(0, 2000)
          : '';

    if (/[\u3040-\u309F\u30A0-\u30FF]/.test(sample)) {
      return 'ja';
    }
    if (/[\uAC00-\uD7AF\u1100-\u11FF]/.test(sample)) {
      return 'ko';
    }
    if (/[\u4E00-\u9FFF]/.test(sample)) {
      return 'zh';
    }
    if (/[\u0400-\u04FF]/.test(sample)) {
      return 'ru';
    }
    return 'en';
  }

  /**
   * Parse TTML / DFXP XML
   */
  static parseTTML(xmlText: string): ParsedCue[] {
    const cues: ParsedCue[] = [];
    try {
      let doc: Document;
      if (typeof DOMParser !== 'undefined') {
        const parser = new DOMParser();
        doc = parser.parseFromString(xmlText, 'text/xml');
      } else {
        return SubtitleParser.parseTTMLRegex(xmlText);
      }

      const parserError = doc.querySelector('parsererror');
      if (parserError) {
        return SubtitleParser.parseTTMLRegex(xmlText);
      }

      const ttElem = doc.querySelector('tt') || doc.documentElement;
      let tickRate = 10000000;
      let frameRate = 30;

      if (ttElem) {
        const tr = ttElem.getAttribute('ttp:tickRate') || ttElem.getAttribute('tickRate');
        if (tr) tickRate = parseFloat(tr) || tickRate;
        const fr = ttElem.getAttribute('ttp:frameRate') || ttElem.getAttribute('frameRate');
        if (fr) frameRate = parseFloat(fr) || frameRate;
      }

      const styles = new Map<string, any>();
      doc.querySelectorAll('style').forEach((st) => {
        const id = st.getAttribute('xml:id') || st.getAttribute('id');
        if (id) {
          styles.set(id, {
            writingMode: st.getAttribute('tts:writingMode') || st.getAttribute('writingMode'),
            textAlign: st.getAttribute('tts:textAlign') || st.getAttribute('textAlign'),
            origin: st.getAttribute('tts:origin') || st.getAttribute('origin'),
            extent: st.getAttribute('tts:extent') || st.getAttribute('extent'),
            displayAlign: st.getAttribute('tts:displayAlign') || st.getAttribute('displayAlign'),
          });
        }
      });

      const regions = new Map<string, any>();
      doc.querySelectorAll('region').forEach((reg) => {
        const id = reg.getAttribute('xml:id') || reg.getAttribute('id');
        if (id) {
          const styleRef = reg.getAttribute('style');
          const inheritedStyle = styleRef ? styles.get(styleRef) || {} : {};

          regions.set(id, {
            id: id.toLowerCase(),
            origin:
              reg.getAttribute('tts:origin') || reg.getAttribute('origin') || inheritedStyle.origin,
            extent: reg.getAttribute('tts:extent') || reg.getAttribute('extent'),
            displayAlign:
              reg.getAttribute('tts:displayAlign') ||
              reg.getAttribute('displayAlign') ||
              inheritedStyle.displayAlign,
            writingMode:
              reg.getAttribute('tts:writingMode') ||
              reg.getAttribute('writingMode') ||
              inheritedStyle.writingMode,
          });
        }
      });

      const pTags = doc.querySelectorAll('p');
      let idCounter = 0;

      pTags.forEach((p) => {
        const beginAttr = p.getAttribute('begin');
        const endAttr = p.getAttribute('end');
        const durAttr = p.getAttribute('dur');

        if (!beginAttr) return;

        let containerOffset = 0;
        let parentRegion: string | null = null;
        let parent = p.parentElement;
        while (parent && parent.nodeName && parent.nodeName.toLowerCase() !== 'tt') {
          const reg = parent.getAttribute('region');
          if (reg && !parentRegion) {
            parentRegion = reg;
          }
          const parentBegin = parent.getAttribute('begin');
          if (parentBegin) {
            containerOffset += SubtitleParser.parseTime(parentBegin, tickRate, frameRate);
          }
          parent = parent.parentElement;
        }

        const start = SubtitleParser.parseTime(beginAttr, tickRate, frameRate) + containerOffset;
        let end: number;

        if (endAttr) {
          end = SubtitleParser.parseTime(endAttr, tickRate, frameRate) + containerOffset;
        } else if (durAttr) {
          end = start + SubtitleParser.parseTime(durAttr, tickRate, frameRate);
        } else {
          end = start + 3;
        }

        const position = SubtitleParser.resolvePosition(p, parentRegion, regions, styles);

        let text = '';
        p.childNodes.forEach((node) => {
          if (node.nodeType === 3) {
            text += node.textContent || '';
          } else if (node.nodeName.toLowerCase() === 'br') {
            text += '\n';
          } else {
            text += node.textContent || '';
          }
        });

        text = SubtitleParser.cleanText(text);
        if (text && end > start) {
          cues.push({
            id: idCounter++,
            start: Math.round(start * 1000) / 1000,
            end: Math.round(end * 1000) / 1000,
            text,
            position,
          });
        }
      });
    } catch (_e) {
      return SubtitleParser.parseTTMLRegex(xmlText);
    }

    cues.sort((a, b) => a.start - b.start);
    cues.forEach((c, idx) => {
      c.id = idx;
    });
    return cues;
  }

  static parseTTMLRegex(xmlText: string): ParsedCue[] {
    const cues: ParsedCue[] = [];
    let tickRate = 10000000;
    const trMatch = xmlText.match(/tickRate="(\d+)"/i);
    if (trMatch) tickRate = parseFloat(trMatch[1]) || tickRate;

    let frameRate = 30;
    const frMatch = xmlText.match(/frameRate="(\d+)"/i);
    if (frMatch) frameRate = parseFloat(frMatch[1]) || frameRate;

    let divOffset = 0;
    let divRegion: string | null = null;
    const divMatch = xmlText.match(/<div\b([^>]*)>/i);
    if (divMatch) {
      const divAttrs = divMatch[1];
      const beginM = divAttrs.match(/\bbegin="([^"]+)"/i);
      if (beginM) {
        divOffset = SubtitleParser.parseTime(beginM[1], tickRate, frameRate);
      }
      const regM = divAttrs.match(/\bregion="([^"]+)"/i);
      if (regM) divRegion = regM[1];
    }

    const styles = new Map<string, any>();
    const styleRegex = /<style\b([^>]*)/gi;
    let sMatch;
    while ((sMatch = styleRegex.exec(xmlText)) !== null) {
      const sAttrs = sMatch[1];
      const idM = sAttrs.match(/\b(?:xml:)?id="([^"]+)"/i);
      if (idM) {
        const originM = sAttrs.match(/\b(?:tts:)?origin="([^"]+)"/i);
        const extentM = sAttrs.match(/\b(?:tts:)?extent="([^"]+)"/i);
        const wmM = sAttrs.match(/\b(?:tts:)?writingMode="([^"]+)"/i);
        const alignM = sAttrs.match(/\b(?:tts:)?displayAlign="([^"]+)"/i);
        styles.set(idM[1], {
          origin: originM ? originM[1] : null,
          extent: extentM ? extentM[1] : null,
          writingMode: wmM ? wmM[1] : null,
          displayAlign: alignM ? alignM[1] : null,
        });
      }
    }

    const regions = new Map<string, any>();
    const regionRegex = /<region\b([^>]*)/gi;
    let rMatch;
    while ((rMatch = regionRegex.exec(xmlText)) !== null) {
      const rAttrs = rMatch[1];
      const idM = rAttrs.match(/\b(?:xml:)?id="([^"]+)"/i);
      if (idM) {
        const styleM = rAttrs.match(/\bstyle="([^"]+)"/i);
        const inherited = styleM ? styles.get(styleM[1]) || {} : {};
        const originM = rAttrs.match(/\b(?:tts:)?origin="([^"]+)"/i);
        const extentM = rAttrs.match(/\b(?:tts:)?extent="([^"]+)"/i);
        const wmM = rAttrs.match(/\b(?:tts:)?writingMode="([^"]+)"/i);
        const alignM = rAttrs.match(/\b(?:tts:)?displayAlign="([^"]+)"/i);
        regions.set(idM[1], {
          id: idM[1].toLowerCase(),
          origin: originM ? originM[1] : inherited.origin || null,
          extent: extentM ? extentM[1] : inherited.extent || null,
          writingMode: wmM ? wmM[1] : inherited.writingMode || null,
          displayAlign: alignM ? alignM[1] : inherited.displayAlign || null,
        });
      }
    }

    const pRegex = /<p\b([^>]*)>(.*?)<\/p>/gis;
    let match;
    let idCounter = 0;

    while ((match = pRegex.exec(xmlText)) !== null) {
      const attrs = match[1];
      const innerHtml = match[2];

      const beginMatch = attrs.match(/\bbegin="([^"]+)"/i);
      if (!beginMatch) continue;
      const beginStr = beginMatch[1];

      const endMatch = attrs.match(/\bend="([^"]+)"/i);
      const durMatch = attrs.match(/\bdur="([^"]+)"/i);

      const start = SubtitleParser.parseTime(beginStr, tickRate, frameRate) + divOffset;
      let end: number;
      if (endMatch) {
        end = SubtitleParser.parseTime(endMatch[1], tickRate, frameRate) + divOffset;
      } else if (durMatch) {
        end = start + SubtitleParser.parseTime(durMatch[1], tickRate, frameRate);
      } else {
        end = start + 3;
      }

      const regMatch = attrs.match(/\bregion="([^"]+)"/i);
      const regId = regMatch ? regMatch[1] : divRegion;
      const regObj = regId ? regions.get(regId) || {} : {};

      const styleMatch = attrs.match(/\bstyle="([^"]+)"/i);
      const styleObj = styleMatch ? styles.get(styleMatch[1]) || {} : {};

      const wmMatch = attrs.match(/\b(?:tts:)?writingMode="([^"]+)"/i);
      const wmVal = (
        wmMatch ? wmMatch[1] : regObj.writingMode || styleObj.writingMode || ''
      ).toLowerCase();

      const originMatch = attrs.match(/\b(?:tts:)?origin="([^"]+)"/i);
      const originVal = originMatch ? originMatch[1] : regObj.origin || styleObj.origin || '';

      const extentMatch = attrs.match(/\b(?:tts:)?extent="([^"]+)"/i);
      const extentVal = extentMatch ? extentMatch[1] : regObj.extent || styleObj.extent || '';

      const alignMatch = attrs.match(/\b(?:tts:)?displayAlign="([^"]+)"/i);
      const alignVal = (
        alignMatch ? alignMatch[1] : regObj.displayAlign || styleObj.displayAlign || ''
      ).toLowerCase();

      const regName = (regId || '').toLowerCase();

      let position: 'bottom' | 'top' | 'left-vertical' | 'right-vertical' = 'bottom';
      if (SubtitleParser.isVerticalWritingMode(wmVal)) {
        const originX = SubtitleParser.parseCoordPercent(originVal, 0);
        position =
          wmVal.includes('lr') || (originX !== null && originX < 40)
            ? 'left-vertical'
            : 'right-vertical';
      } else {
        const isExplicitBottom = regName.includes('bottom') || regName.includes('lower');
        const isExplicitTop =
          regName.includes('top') || regName.includes('upper') || regName.includes('header');

        const originY = SubtitleParser.parseCoordPercent(originVal, 1);
        const extentY = SubtitleParser.parseCoordPercent(extentVal, 1);
        let effectiveY = originY;
        if (alignVal === 'after' && originY !== null && extentY !== null) {
          effectiveY = originY + extentY;
        }

        if (
          !isExplicitBottom &&
          (isExplicitTop ||
            (effectiveY !== null && effectiveY <= 35) ||
            (alignVal === 'before' && originY !== null && originY <= 45))
        ) {
          position = 'top';
        }
      }

      let text = innerHtml
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/?[^>]+(>|$)/g, '')
        .trim();

      text = SubtitleParser.cleanText(text);

      if (text && end > start) {
        cues.push({
          id: idCounter++,
          start: Math.round(start * 1000) / 1000,
          end: Math.round(end * 1000) / 1000,
          text,
          position,
        });
      }
    }

    cues.sort((a, b) => a.start - b.start);
    cues.forEach((c, idx) => {
      c.id = idx;
    });
    return cues;
  }

  static parseVTT(vttText: string): ParsedCue[] {
    const cues: ParsedCue[] = [];
    const lines = vttText.split(/\r?\n/);
    let idCounter = 0;
    let i = 0;

    let vttOffset = 0;
    const offsetMatch = vttText.match(/X-TIMESTAMP-MAP=[^,\r\n]*,LOCAL:(\S+)/i);
    if (offsetMatch) {
      vttOffset = SubtitleParser.parseVTTTime(offsetMatch[1]);
    }

    const timeRegex = /((?:\d{2}:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d{2}:)?\d{2}:\d{2}[.,]\d{3})/;

    while (i < lines.length) {
      const line = lines[i].trim();
      const match = line.match(timeRegex);

      if (match) {
        const start = SubtitleParser.parseVTTTime(match[1]) + vttOffset;
        const end = SubtitleParser.parseVTTTime(match[2]) + vttOffset;

        const settingsStr = line.replace(timeRegex, '').trim().toLowerCase();
        let position: 'bottom' | 'top' | 'left-vertical' | 'right-vertical' = 'bottom';
        if (settingsStr.includes('vertical:rl') || settingsStr.includes('vertical:lr')) {
          position = settingsStr.includes('vertical:lr') ? 'left-vertical' : 'right-vertical';
        } else {
          const lineMatch = settingsStr.match(/\bline:\s*(-?\d+(?:\.\d+)?)(%?)/);
          if (lineMatch) {
            const val = parseFloat(lineMatch[1]);
            const isPercent = lineMatch[2] === '%';
            if ((isPercent && val <= 35) || (!isPercent && val >= 0 && val <= 5)) {
              position = 'top';
            }
          }
        }

        i++;
        const textLines: string[] = [];
        while (i < lines.length && lines[i].trim() !== '') {
          textLines.push(lines[i].trim());
          i++;
        }

        let text = textLines.join('\n');
        text = text.replace(/<[^>]+>/g, '');
        text = SubtitleParser.cleanText(text);

        if (text && end > start) {
          cues.push({
            id: idCounter++,
            start: Math.round(start * 1000) / 1000,
            end: Math.round(end * 1000) / 1000,
            text,
            position,
          });
        }
      }
      i++;
    }

    cues.sort((a, b) => a.start - b.start);
    cues.forEach((c, idx) => {
      c.id = idx;
    });
    return cues;
  }

  static resolvePosition(
    p: Element,
    parentRegionId: string | null,
    regions: Map<string, any> = new Map(),
    styles: Map<string, any> = new Map()
  ): 'bottom' | 'top' | 'left-vertical' | 'right-vertical' {
    const regId = (p.getAttribute('region') || parentRegionId || '').trim();
    const styleId = (p.getAttribute('style') || '').trim();
    const styleObj = styleId ? styles.get(styleId) || {} : {};
    const regObj = regId ? regions.get(regId) || {} : {};

    const writingMode = (
      p.getAttribute('tts:writingMode') ||
      p.getAttribute('writingMode') ||
      regObj.writingMode ||
      styleObj.writingMode ||
      ''
    ).toLowerCase();

    const origin = (
      p.getAttribute('tts:origin') ||
      p.getAttribute('origin') ||
      regObj.origin ||
      styleObj.origin ||
      ''
    ).toLowerCase();

    const extent = (
      p.getAttribute('tts:extent') ||
      p.getAttribute('extent') ||
      regObj.extent ||
      styleObj.extent ||
      ''
    ).toLowerCase();

    const displayAlign = (
      p.getAttribute('tts:displayAlign') ||
      p.getAttribute('displayAlign') ||
      regObj.displayAlign ||
      styleObj.displayAlign ||
      ''
    ).toLowerCase();

    const regName = regId.toLowerCase();

    if (SubtitleParser.isVerticalWritingMode(writingMode)) {
      const originX = SubtitleParser.parseCoordPercent(origin, 0);
      if (writingMode.includes('lr') || (originX !== null && originX < 40)) {
        return 'left-vertical';
      }
      return 'right-vertical';
    }

    const isExplicitBottom = regName.includes('bottom') || regName.includes('lower');
    if (isExplicitBottom) {
      return 'bottom';
    }

    const isExplicitTop =
      regName.includes('top') || regName.includes('upper') || regName.includes('header');
    if (isExplicitTop) {
      return 'top';
    }

    const originY = SubtitleParser.parseCoordPercent(origin, 1);
    const extentY = SubtitleParser.parseCoordPercent(extent, 1);
    let effectiveY = originY;
    if (displayAlign === 'after' && originY !== null && extentY !== null) {
      effectiveY = originY + extentY;
    }

    if (
      (effectiveY !== null && effectiveY <= 35) ||
      (displayAlign === 'before' && originY !== null && originY <= 45)
    ) {
      return 'top';
    }

    return 'bottom';
  }

  static isVerticalWritingMode(writingMode: string): boolean {
    if (!writingMode || typeof writingMode !== 'string') return false;
    const wm = writingMode.trim().toLowerCase();
    if (wm === 'tbrl' || wm === 'tblr' || wm === 'tb') return true;
    if (wm === 'vertical-rl' || wm === 'vertical-lr' || wm === 'vertical') return true;
    if (wm.startsWith('vertical-') || wm.startsWith('tb-')) return true;
    return false;
  }

  static parseCoordPercent(originStr: string, index: number): number | null {
    if (!originStr) return null;
    const parts = originStr.trim().split(/\s+/);
    if (parts.length > index) {
      let val = parseFloat(parts[index]);
      if (isNaN(val)) return null;
      if (parts[index].endsWith('px') && val > 100) {
        val = (val / (index === 0 ? 1920 : 1080)) * 100;
      }
      return val;
    }
    return null;
  }

  static parseTime(timeStr: string, tickRate: number = 10000000, frameRate: number = 30): number {
    if (!timeStr) return 0;
    timeStr = timeStr.trim();

    if (timeStr.endsWith('t')) {
      const ticks = parseInt(timeStr.slice(0, -1), 10);
      return ticks / tickRate;
    }

    if (timeStr.endsWith('s') && !timeStr.endsWith('ms')) {
      return parseFloat(timeStr.slice(0, -1));
    }

    if (timeStr.endsWith('ms')) {
      return parseFloat(timeStr.slice(0, -2)) / 1000;
    }

    const parts = timeStr.split(':');
    if (parts.length === 3) {
      const h = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10);
      const lastPart = parts[2];

      if (lastPart.includes('.')) {
        const s = parseFloat(lastPart);
        return h * 3600 + m * 60 + s;
      } else {
        const s = parseInt(lastPart, 10);
        return h * 3600 + m * 60 + s;
      }
    } else if (parts.length === 4) {
      const h = parseInt(parts[0], 10);
      const m = parseInt(parts[1], 10);
      const s = parseInt(parts[2], 10);
      const f = parseInt(parts[3], 10);
      return h * 3600 + m * 60 + s + f / frameRate;
    }

    const val = parseFloat(timeStr);
    return isNaN(val) ? 0 : val;
  }

  static parseVTTTime(str: string): number {
    str = str.replace(',', '.').trim();
    const parts = str.split(':');
    let h = 0;
    let m = 0;
    let s = 0;

    if (parts.length === 3) {
      h = parseFloat(parts[0]);
      m = parseFloat(parts[1]);
      s = parseFloat(parts[2]);
    } else if (parts.length === 2) {
      m = parseFloat(parts[0]);
      s = parseFloat(parts[1]);
    }
    return h * 3600 + m * 60 + s;
  }

  static cleanText(text: string): string {
    if (!text) return '';
    return text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/\u00A0/g, ' ')
      .trim();
  }

  static decodeHtmlEntities(str: string): string {
    if (!str) return '';
    return SubtitleParser.cleanText(str)
      .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
}

export default SubtitleParser;
