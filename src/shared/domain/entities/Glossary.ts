import { CharacterItem } from './Translation';

/**
 * Character glossary mapping: character name -> CharacterItem domain entity.
 */
export type CharacterGlossaryMap = Record<string, CharacterItem>;

/**
 * Term translation mapping: original term -> translated term.
 */
export type TermGlossaryMap = Record<string, string>;
