export type TranslationStatus =
  | 'untranslated'
  | 'translating'
  | 'raw'
  | 'translated'
  | 'pre_reviewing'
  | 'pre_reviewed'
  | 'reviewing'
  | 'reviewed'
  | 'revised'
  | 'stale';

/**
 * Character glossary entry.
 * Note: Versions are intentionally NOT stored inside CharacterItem.
 * Version tracking for both characters and terms is managed centrally
 * and unified in Context.termVersions (indexed by lowercased character/term name).
 */
export interface CharacterItem {
  canonical: string;
  aliases: string[];
  setByUser?: boolean;
}
