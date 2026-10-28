import { AnkiConnectClient } from './ankiClient';
import {
    AnkiExportOptions,
    AnkiExportResult,
    VocabExportItem,
} from './ankiTypes';
import {
    deduplicateVocabItems,
    downloadTsvFile,
    formatCardsToTsv,
    formatWordToCard,
} from './ankiFormatter';
import { BrowserStorageFactory } from '@shared/infrastructure/storage/BrowserStorageFactory';

const LAST_DECK_STORAGE_KEY = 'ncw_anki_last_deck';

export class AnkiService {
    private readonly client = new AnkiConnectClient();
    private readonly storage = BrowserStorageFactory.getStorage();

    async isConnectAvailable(): Promise<boolean> {
        return this.client.isAvailable();
    }

    async getDeckNames(): Promise<string[]> {
        try {
            return await this.client.getDeckNames();
        } catch {
            return ['Default', 'CoWatcher'];
        }
    }

    async getLastUsedDeck(): Promise<string> {
        try {
            const data = await this.storage.get<string>(LAST_DECK_STORAGE_KEY);
            return (data && data[LAST_DECK_STORAGE_KEY]) || 'CoWatcher';
        } catch {
            return 'CoWatcher';
        }
    }

    async saveLastUsedDeck(deckName: string): Promise<void> {
        if (!deckName) return;
        try {
            await this.storage.set({ [LAST_DECK_STORAGE_KEY]: deckName });
        } catch {
            // Ignore storage errors
        }
    }

    deduplicate(items: VocabExportItem[]): {
        unique: VocabExportItem[];
        duplicateCount: number;
    } {
        return deduplicateVocabItems(items);
    }

    /**
     * Direct HTTP sync to Anki via AnkiConnect.
     */
    async syncToAnki(
        items: VocabExportItem[],
        options: AnkiExportOptions,
    ): Promise<AnkiExportResult> {
        const deckName = options.deckName.trim() || 'CoWatcher';
        const result: AnkiExportResult = {
            success: false,
            added: 0,
            duplicate: 0,
            errors: [],
            deckName,
        };

        if (items.length === 0) {
            result.errors.push('No vocabulary items provided');
            return result;
        }

        const isAvailable = await this.client.isAvailable();
        if (!isAvailable) {
            result.errors.push(
                'AnkiConnect is not reachable at http://127.0.0.1:8765',
            );
            return result;
        }

        // 1. Ensure deck exists
        try {
            await this.client.createDeck(deckName);
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            result.errors.push(`Failed to verify or create deck: ${msg}`);
        }

        // 2. Format cards
        const notes = items.map((item) =>
            formatWordToCard(item.word, item.episodeInfo, options),
        );

        // 3. Deduplicate check with Anki
        let canAddFlags: boolean[] = [];
        try {
            canAddFlags = await this.client.canAddNotes(notes);
        } catch {
            canAddFlags = notes.map(() => true);
        }

        const notesToAdd = notes.filter((_, idx) => canAddFlags[idx] !== false);
        const dupCount = notes.length - notesToAdd.length;
        result.duplicate += dupCount;

        if (notesToAdd.length === 0) {
            result.success = true;
            return result;
        }

        // 4. Batch add notes to Anki
        try {
            const addedIds = await this.client.addNotes(notesToAdd);
            let addedCount = 0;
            let failedOrDup = 0;

            addedIds.forEach((id) => {
                if (typeof id === 'number') {
                    addedCount++;
                } else {
                    failedOrDup++;
                }
            });

            result.added = addedCount;
            result.duplicate += failedOrDup;
            result.success = addedCount > 0 || result.duplicate > 0;
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            result.errors.push(`Failed to add notes to Anki: ${msg}`);
        }

        return result;
    }

    /**
     * Generate standard Anki TSV file and trigger browser download.
     */
    exportTsv(
        items: VocabExportItem[],
        options: AnkiExportOptions,
    ): AnkiExportResult {
        const deckName = options.deckName.trim() || 'CoWatcher';
        const result: AnkiExportResult = {
            success: false,
            added: 0,
            duplicate: 0,
            errors: [],
            deckName,
        };

        if (items.length === 0) {
            result.errors.push('No vocabulary items provided');
            return result;
        }

        try {
            const cards = items.map((item) =>
                formatWordToCard(item.word, item.episodeInfo, options),
            );
            const tsvContent = formatCardsToTsv(cards);
            const cleanDeck = deckName
                .replace(/[^\w\s\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af-]/g, '')
                .trim()
                .replace(/\s+/g, '_');
            const filename = `anki_${cleanDeck || 'vocab'}_${cards.length}_cards.tsv`;

            downloadTsvFile(tsvContent, filename);

            result.success = true;
            result.added = items.length;
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            result.errors.push(`Failed to generate TSV file: ${msg}`);
        }

        return result;
    }
}
