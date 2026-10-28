import { VocabWordItem } from '@shared/domain/entities/Vocabulary';
import {
    AnkiCard,
    AnkiExportOptions,
    VocabExportItem,
} from './ankiTypes';

function escapeHtml(str: string): string {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function highlightKeyword(sentence: string, keyword: string): string {
    if (!sentence || !keyword) return escapeHtml(sentence);
    try {
        const regex = new RegExp(
            `(${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`,
            'gi',
        );
        return sentence
            .split(regex)
            .map((part) =>
                part.toLowerCase() === keyword.toLowerCase()
                    ? `<b>${escapeHtml(part)}</b>`
                    : escapeHtml(part),
            )
            .join('');
    } catch {
        return escapeHtml(sentence);
    }
}

export function deduplicateVocabItems(items: VocabExportItem[]): {
    unique: VocabExportItem[];
    duplicateCount: number;
} {
    const seen = new Map<string, VocabExportItem>();
    let duplicateCount = 0;

    for (const item of items) {
        const key = (item.word.word || '').trim().toLowerCase();
        if (!key) continue;

        if (seen.has(key)) {
            duplicateCount++;
            const existing = seen.get(key)!;
            if (item.word.source === 'user' && existing.word.source !== 'user') {
                seen.set(key, item);
            } else if (
                !existing.word.sentence &&
                item.word.sentence
            ) {
                seen.set(key, item);
            }
        } else {
            seen.set(key, item);
        }
    }

    return {
        unique: Array.from(seen.values()),
        duplicateCount,
    };
}

export function formatWordToCard(
    word: VocabWordItem,
    episodeInfo: { showTitle?: string; movieId?: string },
    options: AnkiExportOptions,
): AnkiCard {
    const rawWord = word.word.trim();
    const pho = (word.phonetic || '').trim();
    const meaning = escapeHtml(word.meaning || '');
    const sentence = word.sentence || '';
    const trans = word.sentenceTranslation || '';
    const pos = word.pos ? `<i>(${escapeHtml(word.pos)})</i>` : '';

    // 1. Furigana / Ruby Reading
    let readingHtml: string;
    if (pho) {
        if (options.formatFurigana !== false) {
            readingHtml = `<ruby>${escapeHtml(rawWord)}<rt>${escapeHtml(pho)}</rt></ruby>`;
        } else {
            readingHtml = `${escapeHtml(rawWord)} [${escapeHtml(pho)}]`;
        }
    } else {
        readingHtml = escapeHtml(rawWord);
    }

    // 2. Front Field (Word + Optional Native TTS tag)
    const voiceLang = options.voiceLang || 'ja_JP';
    let front = readingHtml;
    if (options.enableTts !== false) {
        front += ` [tts:${voiceLang}]${rawWord}[/tts]`;
    }

    // 3. Back Field (Meaning, POS, Example sentence with highlight & translation)
    const backParts: string[] = [];
    if (pos) {
        backParts.push(`<div style="margin-bottom: 4px; color: #888;">${pos}</div>`);
    }
    backParts.push(
        `<div style="font-size: 16px; font-weight: 500; color: #10b981; margin-bottom: 8px;">${meaning}</div>`,
    );

    if (sentence) {
        const highlighted = highlightKeyword(sentence, rawWord);
        backParts.push(
            `<blockquote style="margin: 6px 0; padding: 6px 10px; background: rgba(0,0,0,0.06); border-left: 3px solid #3b82f6; font-size: 13.5px; line-height: 1.4;">${highlighted}</blockquote>`,
        );
        if (trans) {
            backParts.push(
                `<div style="font-size: 12.5px; color: #666; margin-left: 10px; margin-bottom: 6px;">${escapeHtml(trans)}</div>`,
            );
        }
    }

    const notesParts: string[] = [];
    if (episodeInfo.showTitle) {
        notesParts.push(`Show: ${escapeHtml(episodeInfo.showTitle)}`);
    }
    if (episodeInfo.movieId) {
        notesParts.push(`Episode: ${escapeHtml(episodeInfo.movieId)}`);
    }

    // 4. Tags
    const tags = ['CoWatcher', ...(options.tags || [])];
    if (episodeInfo.showTitle) {
        const cleanTitle = episodeInfo.showTitle
            .replace(/[^\w\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g, '_')
            .replace(/_+/g, '_')
            .slice(0, 30);
        if (cleanTitle) tags.push(`CoWatcher::${cleanTitle}`);
    }
    if (word.source === 'user') {
        tags.push('user-marked');
    }

    return {
        deckName: options.deckName,
        modelName: options.modelName || 'Basic',
        fields: {
            Front: front,
            Back: backParts.join(''),
            Reading: pho ? escapeHtml(pho) : '',
            Sentence: sentence ? highlightKeyword(sentence, rawWord) : '',
            SentenceTranslation: escapeHtml(trans),
            Meaning: meaning,
            Notes: notesParts.join(' | '),
        },
        tags,
    };
}

export function formatCardsToTsv(cards: AnkiCard[]): string {
    const lines: string[] = [
        '#separator:Tab',
        '#html:true',
        '#tags column:7',
    ];

    cards.forEach((card) => {
        const sanitize = (text: string | undefined): string =>
            (text || '').replace(/\t/g, '    ').replace(/\r?\n/g, '<br>');

        const row = [
            sanitize(card.fields.Front),
            sanitize(card.fields.Back),
            sanitize(card.fields.Reading),
            sanitize(card.fields.Sentence),
            sanitize(card.fields.Meaning),
            sanitize(card.fields.Notes),
            sanitize(card.tags.join(' ')),
        ];

        lines.push(row.join('\t'));
    });

    return '\uFEFF' + lines.join('\n');
}

export function downloadTsvFile(tsvContent: string, filename: string): void {
    const blob = new Blob([tsvContent], {
        type: 'text/tab-separated-values;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();

    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 600);
}
