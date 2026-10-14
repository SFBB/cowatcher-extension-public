import {
  ITranslatorService,
  TranslateBatchRequest,
  TranslateBatchResponse,
  ReviewBatchRequest,
  ReviewBatchResponse,
  HealthCheckResult,
} from '../../domain/translation/ITranslatorService';
import { LlmService } from '../../application/services/LlmService';
import { CharacterItem } from '@shared/domain/entities/Translation';
import { Language } from '@shared/domain/value-objects/Language';
import { Logger } from '@shared/utils/logger';
import { LLMProvider } from '@shared/domain/entities/PipelineTypes';
import { Context } from '@shared/domain/entities/Context';

export class LlmTranslatorService implements ITranslatorService {
  readonly providerId: LLMProvider;
  private llmService: LlmService;

  private logger: Logger = new Logger('LlmTranslatorService');

  constructor(providerId: LLMProvider = 'ollama') {
    this.providerId = providerId;
    this.llmService = LlmService.getInstance();
  }

  private formatGlossaryForPrompt(
    characters: Record<string, CharacterItem> = {},
    terms: Record<string, string> = {}
  ): string[] {
    const lines: string[] = [];
    for (const [name, val] of Object.entries(characters)) {
      if (typeof val === 'string') {
        lines.push(`${name} -> ${val}`);
      } else if (val && typeof val === 'object') {
        const canonical = val.canonical || name;
        const aliases =
          Array.isArray(val.aliases) && val.aliases.length > 0
            ? ` (Aliases/Called: ${val.aliases.join(', ')})`
            : '';
        lines.push(`${name}${aliases} -> ${canonical}`);
      }
    }
    for (const [term, val] of Object.entries(terms)) {
      if (typeof val === 'string') {
        lines.push(`${term} -> ${val}`);
      }
    }
    return lines;
  }

  /**
   * Builds dual-tier glossary prompt blocks:
   * 1. Master/Manual (User-defined, Immutable, highest priority):
   *    - Merges aliases from model discoveries into manual setup, but uses manual canonical translation.
   *    - Translator must strictly use this; Supervisor CANNOT modify or contradict.
   * 2. Established/Dynamic (Model-discovered):
   *    - Excludes any keys present in manual setup (guaranteed zero overlapping keys).
   *    - Translator strictly adheres; Supervisor can maintain and expand.
   */
  private buildGlossaryBlocks(context: Context, isSupervisor: boolean): string {
    const manualChars: Record<string, CharacterItem> = {};
    for (const [name, manualChar] of Object.entries(context.manualSetupCharacters || {})) {
      const modelChar = context.characters[name];
      const mergedAliases = Array.from(
        new Set([...(manualChar.aliases || []), ...(modelChar?.aliases || [])])
      );
      manualChars[name] = {
        canonical: manualChar.canonical,
        aliases: mergedAliases,
        setByUser: true,
      };
    }

    const autoChars: Record<string, CharacterItem> = {};
    for (const [name, char] of Object.entries(context.characters || {})) {
      if (!context.manualSetupCharacters[name]) {
        autoChars[name] = char;
      }
    }

    const manualTerms: Record<string, string> = { ...(context.manualSetupTerms || {}) };

    const autoTerms: Record<string, string> = {};
    for (const [k, v] of Object.entries(context.terms || {})) {
      if (!context.manualSetupTerms[k]) {
        autoTerms[k] = v;
      }
    }

    const manualLines = this.formatGlossaryForPrompt(manualChars, manualTerms);
    const autoLines = this.formatGlossaryForPrompt(autoChars, autoTerms);

    let block = '';

    if (manualLines.length > 0) {
      block += '\n### MASTER GLOSSARY & CHARACTERS (IMMUTABLE - STRICTLY USER-DEFINED) ###\n';
      block += isSupervisor
        ? 'These terms and character translations are user-locked. YOU MUST NOT MODIFY OR OVERRIDE THEIR CANONICAL TRANSLATIONS, but you CAN discover and report new aliases for them.\n'
        : 'You must strictly and verbatim use these exact character names and terminology translations.\n';
      block += manualLines.map((line) => '- ' + line).join('\n') + '\n';
      block += '### END MASTER GLOSSARY ###\n\n';
    }

    if (autoLines.length > 0) {
      block += '### ESTABLISHED GLOSSARY & CHARACTERS ###\n';
      block += isSupervisor
        ? 'These are model-discovered terms. Verify consistency and suggest refinements or new terms if found.\n'
        : 'Strictly adhere to these character names and terms for consistency.\n';
      block += autoLines.map((line) => '- ' + line).join('\n') + '\n';
      block += '### END ESTABLISHED GLOSSARY ###\n\n';
    }

    return block;
  }

  /**
   * Cleans ID markers (e.g., [643], [643]:, 【643】, 【643】：) and extraneous wrapper quotes
   */
  private cleanTranslationText(text: string): string {
    if (!text) return '';
    return (
      text
        // Strip leading brackets and IDs: [643]:, 【643】：, [643] -, 643., etc.
        .replace(/^(?:\[|【|\()\s*\d+\s*(?:\]|】|\))\s*[:：\-.]?\s*/, '')
        .replace(/^(\d+)\s*[:：\-.]\s*/, '')
        // Strip any residual [id] or 【id】 markers within text
        .replace(/(?:\[|【)\s*\d+\s*(?:\]|】)\s*[:：]?\s*/g, '')
        // Strip wrapping quotes
        .replace(/^["'“”](.*)["'“”]$/, '$1')
        .trim()
    );
  }

  /**
   * Robustly parses numbered subtitles from LLM response text.
   * Extracts text segments bounded by target ID markers (e.g. [81]:, 【81】：, 81., etc.).
   * If an ID marker is missing in the output, it is omitted rather than blindly guessed by index,
   * completely preventing downstream cue misalignment.
   */
  private parseNumberedSubtitles(
    text: string,
    targetIds: Set<number>,
    orderedItems: Array<{ id: number }>
  ): Record<number, string> {
    const resultMap: Record<number, string> = {};
    if (!text) return resultMap;

    // Pattern 1: Bracketed markers [123] or 【123】, preceded by start, newline, or whitespace
    // Pattern 2: Line starters: 123. or 123: or 123： or #123: at the beginning of a line
    const markerRegex =
      /(?:(?:^|\n|\s)(?:\[|【)\s*(\d+)\s*(?:\]|】)\s*[:：]?\s*|(?:^|\n)\s*(?:#)?\s*(\d+)\s*[\.:：]\s*)/g;
    const markers: Array<{ id: number; start: number; end: number }> = [];

    let match: RegExpExecArray | null;
    while ((match = markerRegex.exec(text)) !== null) {
      const idStr = match[1] || match[2];
      if (!idStr) continue;
      const id = parseInt(idStr, 10);
      if (targetIds.has(id)) {
        markers.push({
          id,
          start: match.index,
          end: match.index + match[0].length,
        });
      }
    }

    if (markers.length > 0) {
      markers.sort((a, b) => a.start - b.start);
      for (let i = 0; i < markers.length; i++) {
        const current = markers[i];
        const nextStart = i + 1 < markers.length ? markers[i + 1].start : text.length;
        const rawChunk = text.slice(current.end, nextStart).trim();
        if (rawChunk) {
          resultMap[current.id] = this.cleanTranslationText(rawChunk);
        }
      }
      return resultMap;
    }

    // Fallback ONLY when absolutely no markers were matched:
    const rawLines = text
      .split('\n')
      .map((l) => l.trim())
      .filter(
        (l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('*') && !l.startsWith('---')
      );

    if (rawLines.length === orderedItems.length) {
      orderedItems.forEach((item, index) => {
        resultMap[item.id] = this.cleanTranslationText(rawLines[index]);
      });
    } else {
      this.logger.warn(
        'Translator',
        `Batch translation returned unformatted text without ID markers, and line count (${rawLines.length}) does not match items count (${orderedItems.length}). Discarding unverified batch to prevent misalignment.`
      );
    }

    return resultMap;
  }

  async translateBatch(req: TranslateBatchRequest): Promise<TranslateBatchResponse> {
    const { items, targetLang, contextItems = [], context, signal, movieId } = req;
    if (!items || items.length === 0) return { success: true, results: {} };

    const ctx = context;
    let contextBlock = '';
    if (ctx && ctx.isWarmedUp) {
      contextBlock += `Show Title: ${ctx.title}\n`;
      const episode = movieId ? ctx.getEpisodeContext(movieId) : null;
      const synopsisParts = [
        ctx.showSynopsis ? `Show: ${ctx.showSynopsis}` : '',
        episode?.synopsis ? `Episode: ${episode.synopsis}` : '',
      ].filter(Boolean);
      if (synopsisParts.length > 0) {
        contextBlock += `Background Synopsis:\n${synopsisParts.join('\n')}\n`;
      }

      contextBlock += this.buildGlossaryBlocks(ctx, false);
    }

    let contextDialogues = '';
    if (contextItems.length > 0) {
      const validCtx = contextItems.map((c) => {
        const orig = (c.rawText || '').replace(/\n+/g, ' ');
        const trans = c.transText ? ` -> Translated: "${c.transText.replace(/\n+/g, ' ')}"` : '';
        return `[Context #${c.id}]: "${orig}"${trans}`;
      });
      contextDialogues = `--- Preceding Dialogue Context ---\n${validCtx.join('\n')}\n\n`;
    }

    const targetLangPrompt = Language.resolve(targetLang as any).promptName;
    const systemPrompt = `You are a professional subtitle translator.
${contextBlock}
Translate the numbered subtitle lines into ${targetLangPrompt}.
Maintain natural dialogue tone and conversational context between speakers.
Strictly adhere to the established character names, aliases, and terms in the glossary.
Strictly translate every numbered line individually. Output every line ID without merging or omitting any lines.

Return in this exact format:
[index]: translated_text`;

    const userLines = items
      .map((item) => `[${item.id}]: ${item.rawText.replace(/\n+/g, ' ')}`)
      .join('\n');
    const fullUserPrompt = contextDialogues
      ? `${contextDialogues}--- Target Lines to Translate ---\n${userLines}`
      : userLines;

    const MAX_RETRIES = 2;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (signal?.aborted) return { success: false, error: 'Aborted' };

      try {
        const rawResponse = await this.llmService.callChat('translator', {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: fullUserPrompt },
          ],
          temperature: attempt === 1 ? 0.2 : 0.1,
          signal,
        });

        const cleanResponse = rawResponse
          .replace(/<think[\s\S]*?<\/think>/gi, '')
          .replace(/<thought[\s\S]*?<\/thought>/gi, '')
          .trim();

        const targetIds = new Set(items.map((it) => it.id));
        const resultMap = this.parseNumberedSubtitles(cleanResponse, targetIds, items);

        // Safety Guard: Validate that EVERY requested cue was translated with non-empty text
        const missingIds = items.filter((it) => !resultMap[it.id] || !resultMap[it.id].trim());
        if (missingIds.length > 0) {
          const warnMsg = `Safety Guard: Batch translation count mismatch (expected ${items.length} cues, but received ${Object.keys(resultMap).length} valid cues). Missing cue IDs: [${missingIds.map((m) => m.id).join(', ')}].`;
          if (attempt < MAX_RETRIES) {
            this.logger.warn(
              'Translator',
              `${warnMsg} Retrying entire batch (attempt ${attempt + 1}/${MAX_RETRIES})...`
            );
            continue;
          } else {
            this.logger.error(
              'Translator',
              `${warnMsg} Discarding entire batch to trigger retry and prevent subtitle misalignment.`
            );
            return { success: false, error: warnMsg };
          }
        }

        return { success: true, results: resultMap };
      } catch (err: any) {
        if (attempt === MAX_RETRIES || err.name === 'AbortError' || signal?.aborted) {
          return { success: false, error: err.message };
        }
        this.logger.warn(
          'Translator',
          `Batch translation attempt ${attempt} failed: ${err.message}. Retrying...`
        );
      }
    }

    return { success: false, error: 'Batch translation failed after retries' };
  }

  private fallbackExtractSupervisorJson(text: string): any {
    const result: {
      corrections: Record<string, string>;
      new_characters: Record<string, any>;
      new_terms: Record<string, string>;
    } = {
      corrections: {},
      new_characters: {},
      new_terms: {},
    };

    // 1. Extract corrections section
    const corrMatch = text.match(/"corrections"\s*:\s*\{([\s\S]*?)\}(?:\s*,|\s*\}|\s*$)/i);
    if (corrMatch) {
      const corrBody = corrMatch[1];
      const itemRegex = /"(\d+)"\s*:\s*"((?:[^"\\]|\\.)*?)"/g;
      let m: RegExpExecArray | null;
      while ((m = itemRegex.exec(corrBody)) !== null) {
        result.corrections[m[1]] = m[2];
      }
    }

    // 2. Extract new_terms section
    const termsMatch = text.match(/"new_terms"\s*:\s*\{([\s\S]*?)\}(?:\s*,|\s*\}|\s*$)/i);
    if (termsMatch) {
      const termsBody = termsMatch[1];
      const termRegex = /"([^"]+)"\s*:\s*"((?:[^"\\]|\\.)*?)"/g;
      let m: RegExpExecArray | null;
      while ((m = termRegex.exec(termsBody)) !== null) {
        result.new_terms[m[1]] = m[2];
      }
    }

    return result;
  }

  private parseSupervisorJson(rawContent: string): any {
    if (!rawContent) return {};

    // 1. Strip reasoning/thinking tags and markdown fences
    let cleaned = rawContent
      .replace(/<think[\s\S]*?<\/think>/gi, '')
      .replace(/<thought[\s\S]*?<\/thought>/gi, '')
      .trim();

    const jsonFenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (jsonFenceMatch) {
      cleaned = jsonFenceMatch[1].trim();
    }

    // 2. Extract candidate JSON object boundaries
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace <= firstBrace) {
      return this.fallbackExtractSupervisorJson(cleaned);
    }
    const jsonStr = cleaned.slice(firstBrace, lastBrace + 1);

    // 3. Try standard JSON.parse first
    try {
      return JSON.parse(jsonStr);
    } catch {
      // Proceed to repair strategies
    }

    // 4. Repair strategy 1: Trailing commas
    let repaired = jsonStr.replace(/,\s*([\]}])/g, '$1');
    try {
      return JSON.parse(repaired);
    } catch {
      // Proceed to repair strategy 2
    }

    // 5. Repair strategy 2: Unescaped double quotes inside key-value string lines
    try {
      const repairedLines = repaired.split('\n').map((line) => {
        // Match line like: "123": "some text "quotes" here",
        const kvMatch = line.match(/^(\s*"[^"]+"\s*:\s*")(.*)("\s*,?\s*)$/);
        if (kvMatch) {
          const [, prefix, val, suffix] = kvMatch;
          // Escape unescaped double quotes in the value
          const cleanVal = val.replace(/(?<!\\)"/g, '\\"');
          return `${prefix}${cleanVal}${suffix}`;
        }
        return line;
      });
      return JSON.parse(repairedLines.join('\n'));
    } catch {
      // Proceed to fallback extraction
    }

    // 6. Repair strategy 3: Fallback regex extraction of key-value maps
    try {
      return this.fallbackExtractSupervisorJson(cleaned);
    } catch (finalErr) {
      this.logger.warn('LLM Translation', 'All supervisor JSON parsing attempts failed:', finalErr);
      return {};
    }
  }

  async reviewBatch(req: ReviewBatchRequest): Promise<ReviewBatchResponse> {
    const { items, contextItems = [], targetLang, signal, context, movieId } = req;

    if (!items || items.length === 0) {
      return { success: true, corrections: {} };
    }

    let contextBlock = '';
    if (contextItems.length > 0) {
      const validCtx = contextItems.map((c) => {
        const orig = (c.rawText || '').replace(/\n+/g, ' ');
        const trans = c.transText ? ` -> Translated: "${c.transText.replace(/\n+/g, ' ')}"` : '';
        return `[Context #${c.id}]: "${orig}"${trans}`;
      });
      contextBlock = `Preceding Dialogue Context:\n${validCtx.join('\n')}\n\n`;
    }

    const dialoguesText = items
      .map((item) => {
        const origText = item.rawText.replace(/\n+/g, ' ');
        const transText = item.transText.replace(/\n+/g, ' ');
        return `[${item.id}] Original: "${origText}" | Translated: "${transText}"`;
      })
      .join('\n');

    const targetLangPrompt = targetLang.promptName;
    let showLine = '';
    let synopsisLine = '';
    let glossaryBlock = '';

    if (context) {
      if (context.title) {
        showLine = `Current Show: ${context.title}\n`;
      }
      const episode = movieId ? context.getEpisodeContext(movieId) : null;
      const synopsisParts = [
        context.showSynopsis ? `Show: ${context.showSynopsis}` : '',
        episode?.synopsis ? `Episode: ${episode.synopsis}` : '',
      ].filter(Boolean);

      if (synopsisParts.length > 0) {
        synopsisLine = `Background Synopsis:\n${synopsisParts.join('\n')}\n`;
      }

      glossaryBlock = this.buildGlossaryBlocks(context, true);
    }

    const systemPrompt = `You are a senior subtitle translation supervisor and editor.
${showLine}Target Language: ${targetLangPrompt}
${synopsisLine}
Review the dialogue translations for consistency of character names, terminology, and tone.
${glossaryBlock}CRITICAL JSON OUTPUT RULES:
- Output strictly a single JSON object without markdown fences, explanation, or commentary.
- Ensure all double quotes inside string values are properly escaped with backslashes (e.g. \\"quote\\"). Never leave raw unescaped double quotes inside translations.
- Do NOT include trailing commas.

JSON Schema:
{
  "corrections": { "cueId": "improved translation" },
  "new_characters": { "Original Name": { "canonical": "Target Name", "aliases": ["new_alias"] } },
  "new_terms": { "Term": "Translation" }
}

Guidelines for corrections:
- Only provide corrections for cues that have accuracy, terminology, name consistency, or tone issues.

Guidelines for new_characters and new_terms:
- Actively identify and extract any recurring character names, nicknames, locations, proper nouns, and specialized terms from the dialogues.
- If an entity or term is not yet registered in the glossary above, you MUST extract it and provide its canonical translation in "new_characters" or "new_terms".
- For Master characters: do NOT modify their canonical translation, but you CAN discover and report newly spoken aliases for them under "new_characters".
- For Established items: you may suggest refined translations, add aliases, or correct inconsistencies.
- Do NOT output placeholder entries like "Original Name", "Target Name", or "Term". Leave objects empty if no new entities are found.`;

    const userPrompt = `${contextBlock}Dialogues to Review:\n${dialoguesText}`;

    try {
      const rawContent = await this.llmService.callChat('supervisor', {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.1,
        jsonMode: true,
        signal,
      });

      const parsed = this.parseSupervisorJson(rawContent);

      const corrections: Record<number, string> = {};
      if (parsed.corrections && typeof parsed.corrections === 'object') {
        for (const [k, v] of Object.entries(parsed.corrections)) {
          const numId = parseInt(k, 10);
          if (!isNaN(numId) && typeof v === 'string') {
            corrections[numId] = this.cleanTranslationText(v);
          }
        }
      }

      const newCharacters: Record<string, CharacterItem> = {};
      if (parsed.new_characters && typeof parsed.new_characters === 'object') {
        for (const [k, v] of Object.entries(parsed.new_characters)) {
          const key = k.trim();
          if (!key || key.toLowerCase() === 'original name') continue;

          if (typeof v === 'string') {
            const canonical = v.trim();
            if (canonical && canonical.toLowerCase() !== 'target name') {
              newCharacters[key] = { canonical, aliases: [] };
            }
          } else if (v && typeof v === 'object') {
            const obj = v as any;
            const canonical = String(obj.canonical || obj.name || key).trim();
            if (canonical && canonical.toLowerCase() !== 'target name') {
              const aliases = Array.isArray(obj.aliases)
                ? obj.aliases.map((a: unknown) => String(a).trim()).filter(Boolean)
                : [];
              newCharacters[key] = {
                canonical,
                aliases: aliases.filter((a: string) => a.toLowerCase() !== 'new_alias'),
              };
            }
          }
        }
      }

      const newTerms: Record<string, string> = {};
      if (
        parsed.new_terms &&
        typeof parsed.new_terms === 'object' &&
        !Array.isArray(parsed.new_terms)
      ) {
        for (const [k, v] of Object.entries(parsed.new_terms)) {
          const key = k.trim();
          const val = typeof v === 'string' ? v.trim() : '';
          if (
            key &&
            val &&
            !(key.toLowerCase() === 'term' && val.toLowerCase() === 'translation')
          ) {
            newTerms[key] = val;
          }
        }
      }

      return {
        success: true,
        corrections,
        newCharacters: Object.keys(newCharacters).length > 0 ? newCharacters : undefined,
        newTerms: Object.keys(newTerms).length > 0 ? newTerms : undefined,
      };
    } catch (err: any) {
      this.logger.warn('LLM Translation', 'Supervisor Review LLM call failed:', err);
      return { success: false, error: err.message };
    }
  }

  async checkHealth(): Promise<HealthCheckResult> {
    try {
      const translatorClient = this.llmService.getClient('translator');
      const translatorRes = await translatorClient.checkConnection();
      const supervisorClient = this.llmService.getClient('supervisor');
      const supervisorRes = await supervisorClient.checkConnection();
      return {
        ok: translatorRes.ok && supervisorRes.ok,
        message:
          translatorRes.message ||
          `Connected (${translatorRes.models?.length || 0} models available)`,
      };
    } catch (e: any) {
      return { ok: false, message: e.message || 'Connection check failed' };
    }
  }
}
