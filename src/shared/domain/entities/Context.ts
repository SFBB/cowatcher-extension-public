import { Language, LanguageInfo } from '../value-objects/Language';
import { CharacterGlossaryMap, TermGlossaryMap } from './Glossary';

export interface EpisodeContext {
  seasonId: string;
  videoId: string;
  episodeNumber?: string;
  title?: string;
  synopsis: string;
}

export interface ContextDTO {
  showId?: string | null;
  title: string;
  mainTitle: string;
  targetLanguage: LanguageInfo;
  known: boolean;
  showSynopsis?: string;
  episodes: EpisodeContext[];
  characters: CharacterGlossaryMap;
  manualSetupCharacters: CharacterGlossaryMap;
  terms: TermGlossaryMap;
  manualSetupTerms: TermGlossaryMap;
  /**
   * Unified version registry for BOTH character names and glossary terms.
   * Key is lowercased term/character name, value is incremental integer version.
   * Used for stale cue detection and prompt version tracking.
   */
  termVersions: Record<string, number>;
  isWarmedUp: boolean;
  updatedAt: number;
}

export class Context {
  readonly showId?: string | null;
  readonly title: string;
  readonly mainTitle: string;
  readonly targetLanguage: LanguageInfo;
  readonly known: boolean;
  readonly showSynopsis?: string;
  readonly episodes: EpisodeContext[];
  readonly characters: CharacterGlossaryMap;
  readonly manualSetupCharacters: CharacterGlossaryMap;
  readonly terms: TermGlossaryMap;
  readonly manualSetupTerms: TermGlossaryMap;
  /**
   * Unified version registry for BOTH character names and glossary terms.
   * Key is lowercased term/character name, value is incremental integer version.
   */
  readonly termVersions: Record<string, number>;
  isWarmedUp: boolean;
  readonly updatedAt: number;

  constructor(props?: Partial<ContextDTO>) {
    this.showId = props?.showId;
    this.title = props?.title ?? '';
    this.mainTitle = props?.mainTitle ?? '';
    this.targetLanguage = Language.resolve(props?.targetLanguage);
    this.known = props?.known ?? false;
    this.showSynopsis = props?.showSynopsis;
    this.episodes = props?.episodes || [];
    this.characters = props?.characters ?? {};
    this.manualSetupCharacters = props?.manualSetupCharacters ?? {};
    this.terms = props?.terms ?? {};
    this.manualSetupTerms = props?.manualSetupTerms ?? {};
    this.termVersions = props?.termVersions ?? {};
    this.isWarmedUp = props?.isWarmedUp ?? false;
    this.updatedAt = props?.updatedAt ?? Date.now();
  }

  static createEmpty(targetLanguage: LanguageInfo = Language.DEFAULT): Context {
    return new Context({
      targetLanguage,
      updatedAt: Date.now(),
    });
  }

  static fromDTO(dto: ContextDTO | any): Context {
    if (!dto) return Context.createEmpty();
    return new Context({
      ...dto,
      targetLanguage: dto.targetLanguage,
    });
  }

  toDTO(): ContextDTO {
    return {
      showId: this.showId,
      title: this.title,
      mainTitle: this.mainTitle,
      targetLanguage: this.targetLanguage,
      known: this.known,
      showSynopsis: this.showSynopsis,
      episodes: this.episodes,
      characters: { ...this.characters },
      manualSetupCharacters: { ...this.manualSetupCharacters },
      terms: { ...this.terms },
      manualSetupTerms: { ...this.manualSetupTerms },
      termVersions: { ...this.termVersions },
      isWarmedUp: this.isWarmedUp,
      updatedAt: this.updatedAt,
    };
  }

  markWarmup(): void {
    this.isWarmedUp = true;
  }

  getEpisodeContext(episodeId: string): EpisodeContext | null {
    return this.episodes.find((ep) => ep.videoId === episodeId) ?? null;
  }

  /**
   * Returns merged character glossary where manualSetupCharacters takes precedence for canonical,
   * while aliases from both manual and model discoveries are merged and deduplicated.
   */
  getEffectiveCharacters(): CharacterGlossaryMap {
    const result: CharacterGlossaryMap = {};

    // 1. Start with model-discovered characters
    for (const [name, char] of Object.entries(this.characters || {})) {
      result[name] = {
        canonical: char.canonical || name,
        aliases: Array.isArray(char.aliases) ? [...char.aliases] : [],
        setByUser: false,
      };
    }

    // 2. Overlay manual setup characters: user canonical overrides, aliases merge
    for (const [name, manualChar] of Object.entries(this.manualSetupCharacters || {})) {
      const existing = result[name];
      if (existing) {
        const mergedAliases = Array.from(
          new Set([...(manualChar.aliases || []), ...(existing.aliases || [])])
        );
        result[name] = {
          canonical: manualChar.canonical || existing.canonical || name,
          aliases: mergedAliases,
          setByUser: true,
        };
      } else {
        result[name] = {
          canonical: manualChar.canonical || name,
          aliases: Array.isArray(manualChar.aliases) ? [...manualChar.aliases] : [],
          setByUser: true,
        };
      }
    }

    return result;
  }

  /**
   * Returns merged term glossary where manualSetupTerms takes precedence.
   */
  getEffectiveTerms(): TermGlossaryMap {
    return {
      ...this.terms,
      ...this.manualSetupTerms,
    };
  }

  getTermVersion(term: string): number {
    return this.termVersions[term.toLowerCase()] || 0;
  }

  checkTermStaleness(usedTerms?: Record<string, number>): boolean {
    if (!usedTerms || Object.keys(usedTerms).length === 0) return false;
    for (const [term, version] of Object.entries(usedTerms)) {
      const currentVer = this.getTermVersion(term);
      if (currentVer !== version) {
        return true;
      }
    }
    return false;
  }

  updateTerm(key: string, value: string): Context {
    const normKey = key.toLowerCase();
    const nextVersion = (this.termVersions[normKey] || 0) + 1;
    const nextVersions = { ...this.termVersions, [normKey]: nextVersion };

    const nextManualTerms: TermGlossaryMap = { ...this.manualSetupTerms, [key]: value };

    return new Context({
      ...this.toDTO(),
      manualSetupTerms: nextManualTerms,
      termVersions: nextVersions,
      updatedAt: Date.now(),
    });
  }

  deleteTerm(key: string): Context {
    const normKey = key.toLowerCase();
    const nextVersions = { ...this.termVersions };
    delete nextVersions[normKey];

    const nextManualTerms: TermGlossaryMap = { ...this.manualSetupTerms };
    delete nextManualTerms[key];
    const nextTerms: TermGlossaryMap = { ...this.terms };
    delete nextTerms[key];

    return new Context({
      ...this.toDTO(),
      terms: nextTerms,
      manualSetupTerms: nextManualTerms,
      termVersions: nextVersions,
      updatedAt: Date.now(),
    });
  }

  updateCharacter(name: string, canonical: string, aliases: string[] = []): Context {
    const normKey = name.toLowerCase();
    const nextVersion = (this.termVersions[normKey] || 0) + 1;
    const nextVersions = { ...this.termVersions, [normKey]: nextVersion };

    const nextManualChars: CharacterGlossaryMap = {
      ...this.manualSetupCharacters,
      [name]: { canonical, aliases, setByUser: true },
    };

    return new Context({
      ...this.toDTO(),
      manualSetupCharacters: nextManualChars,
      termVersions: nextVersions,
      updatedAt: Date.now(),
    });
  }

  deleteCharacter(name: string): Context {
    const normKey = name.toLowerCase();
    const nextVersions = { ...this.termVersions };
    delete nextVersions[normKey];

    const nextManualChars: CharacterGlossaryMap = { ...this.manualSetupCharacters };
    delete nextManualChars[name];
    const nextCharacters: CharacterGlossaryMap = { ...this.characters };
    delete nextCharacters[name];

    return new Context({
      ...this.toDTO(),
      characters: nextCharacters,
      manualSetupCharacters: nextManualChars,
      termVersions: nextVersions,
      updatedAt: Date.now(),
    });
  }

  mergeDiscoveredGlossary(newCharacters: CharacterGlossaryMap, newTerms: TermGlossaryMap): Context {
    const mergedChars: CharacterGlossaryMap = { ...this.characters };
    const nextVersions: Record<string, number> = { ...this.termVersions };

    for (const [name, char] of Object.entries(newCharacters)) {
      if (!this.manualSetupCharacters[name]) {
        mergedChars[name] = char;
        const norm = name.toLowerCase();
        nextVersions[norm] = (nextVersions[norm] || 0) + 1;
      } else if (Array.isArray(char.aliases) && char.aliases.length > 0) {
        // Model discovered new aliases for manual setup character: preserve manual canonical, merge aliases
        const existingAliases = mergedChars[name]?.aliases || [];
        const mergedAliases = Array.from(new Set([...existingAliases, ...char.aliases]));
        mergedChars[name] = {
          canonical: this.manualSetupCharacters[name].canonical,
          aliases: mergedAliases,
          setByUser: false,
        };
        const norm = name.toLowerCase();
        nextVersions[norm] = (nextVersions[norm] || 0) + 1;
      }
    }

    const mergedTerms: TermGlossaryMap = { ...this.terms };
    for (const [k, v] of Object.entries(newTerms)) {
      // Model never overwrites user manual setup terms
      if (!this.manualSetupTerms[k] && !this.terms[k]) {
        mergedTerms[k] = v;
        const norm = k.toLowerCase();
        nextVersions[norm] = (nextVersions[norm] || 0) + 1;
      }
    }

    return new Context({
      ...this.toDTO(),
      characters: mergedChars,
      terms: mergedTerms,
      termVersions: nextVersions,
      updatedAt: Date.now(),
    });
  }

  reset(): Context {
    return Context.createEmpty(this.targetLanguage);
  }
}
