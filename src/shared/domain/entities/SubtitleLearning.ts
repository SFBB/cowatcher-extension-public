/**
 * Subtitle Learning & Word Tokenization Domain Entities
 */

export interface SubtitleToken {
  id: string; // Unique token identifier within cue (e.g. "c1_t0")
  text: string; // Surface text form (e.g. "食べました", "hello")
  isWordLike: boolean; // True if word/token, false if pure punctuation or whitespace
  index: number; // Character start offset in cue text
  pos?: string; // Part of speech (e.g., "verb", "noun")
  lemma?: string; // Base / dictionary form (e.g. "食べる")
  reading?: string; // Phonetic / kana / pinyin / furigana
  meaning?: string; // Quick definition
  isUserMarked?: boolean; // True if saved in user's vocabulary book
}

export interface LearningCueItem {
  cueId: number;
  originalText: string;
  translatedText?: string;
  tokens: SubtitleToken[];
}

export interface WordLookupRequest {
  word: string;
  contextSentence: string;
  contextTranslation?: string;
  sourceLang: string;
  targetLang: string;
}

export interface WordLookupResult {
  word: string;
  lemma: string; // Dictionary form
  reading: string; // Phonetic/furigana
  pos: string; // Part of speech
  meaning: string; // Definition in target language
  grammarNotes?: string; // Grammatical usage or inflections
  exampleSentence?: string; // Context or dictionary example
  exampleTranslation?: string;
}
