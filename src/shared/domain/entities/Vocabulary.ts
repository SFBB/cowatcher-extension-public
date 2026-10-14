/**
 * Individual vocabulary word item extracted from subtitle dialogues.
 */
export interface VocabWordItem {
  word: string;
  pos: string;
  phonetic: string;
  meaning: string;
  sentence: string;
  sentenceTranslation: string;
  timestamp: number;
  frequency: number;
}

/**
 * Aggregated episode-level vocabulary dataset stored in browser storage.
 */
export interface EpisodeVocabData {
  movieId: string;
  showTitle: string;
  sourceLanguage: string;
  targetLanguage: string;
  difficulty: string;
  customPrompt: string;
  model: string;
  updatedAt: number;
  totalWords?: number;
  words: VocabWordItem[];
}
