/**
 * Character Mapping Service
 *
 * Handles find/replace of real names with parody names in text.
 * Uses StaticDataRegistry for mappings (no database calls).
 */

import { logger } from '@feed/shared';
import { CRYPTO_PARODY_NAMES } from '../data/reality-grounding';
import {
  type CharacterMapping,
  type OrganizationMapping,
  StaticDataRegistry,
} from './static-data-registry';

export interface TextReplacementResult {
  transformedText: string;
  characterMappings: Record<string, string>; // real -> parody
  organizationMappings: Record<string, string>; // real -> parody
  replacementCount: number;
}

interface ActiveCharacterMapping extends CharacterMapping {
  isActive: boolean;
}

interface ActiveOrganizationMapping extends OrganizationMapping {
  isActive: boolean;
}

export class CharacterMappingService {
  private characterMappingsCache: ActiveCharacterMapping[] = [];
  private organizationMappingsCache: ActiveOrganizationMapping[] = [];
  private initialized = false;

  private loadMappings(): void {
    if (this.initialized) {
      return;
    }

    const charMappings = StaticDataRegistry.getAllCharacterMappings();
    const orgMappings = StaticDataRegistry.getAllOrganizationMappings();

    this.characterMappingsCache = charMappings
      .map((m) => ({ ...m, isActive: true }))
      .sort((a, b) => b.priority - a.priority);

    this.organizationMappingsCache = orgMappings
      .map((m) => ({ ...m, isActive: true }))
      .sort((a, b) => b.priority - a.priority);

    this.initialized = true;
    logger.info(
      `Loaded ${this.characterMappingsCache.length} character and ${this.organizationMappingsCache.length} organization mappings`,
      undefined,
      'CharacterMappingService'
    );
  }

  /** Build word-to-word mapping from real name to parody name */
  private buildWordMapping(
    realName: string,
    parodyName: string
  ): Map<string, string> {
    const realWords = realName.split(/\s+/);
    const parodyWords = parodyName.split(/\s+/);
    const wordMap = new Map<string, string>();

    // Map corresponding words by position
    for (let i = 0; i < realWords.length && i < parodyWords.length; i++) {
      const realWord = realWords[i];
      const parodyWord = parodyWords[i];
      if (realWord && parodyWord) {
        wordMap.set(realWord.toLowerCase(), parodyWord);
      }
    }

    return wordMap;
  }

  /**
   * Preserve case pattern: lowercase→lowercase, UPPERCASE→UPPERCASE.
   * Mixed case keeps parody's original casing to preserve AI-pun styling.
   */
  private preserveCase(original: string, replacement: string): string {
    if (!original || !replacement) return replacement;

    // Check if original is all lowercase → lowercase output
    if (original === original.toLowerCase()) {
      return replacement.toLowerCase();
    }

    // Check if original is all uppercase → uppercase output
    if (original === original.toUpperCase()) {
      return replacement.toUpperCase();
    }

    return replacement;
  }

  private generateUsername(name: string): string {
    return name.toLowerCase().replace(/\s+/g, '');
  }

  /** Get replacement for search term - full name or word-to-word mapped alias */
  private getReplacementForTerm(
    searchName: string,
    realName: string,
    parodyName: string
  ): string {
    // If searching for the full name, return full parody name
    if (searchName.toLowerCase() === realName.toLowerCase()) {
      return parodyName;
    }

    const searchLower = searchName.toLowerCase();
    if (
      !/\s/.test(searchName) &&
      parodyName.split(/\s+/).some((word) => word.toLowerCase() === searchLower)
    ) {
      return searchName;
    }

    // Build word mapping and look for the search term
    const wordMap = this.buildWordMapping(realName, parodyName);

    // Check if searchName is a single word that maps
    if (wordMap.has(searchLower)) {
      return wordMap.get(searchLower)!;
    }

    // For multi-word aliases, try to map each word
    const searchWords = searchName.split(/\s+/);
    if (searchWords.length > 1) {
      const mappedWords = searchWords.map((word) => {
        const mapped = wordMap.get(word.toLowerCase());
        return mapped || word; // Keep original if no mapping
      });
      return mappedWords.join(' ');
    }

    return parodyName;
  }

  /** Transform text by replacing real names with parody equivalents */
  async transformText(text: string): Promise<TextReplacementResult> {
    this.loadMappings();

    let transformedText = text;
    const characterMappingsResult: Record<string, string> = {};
    const organizationMappingsResult: Record<string, string> = {};
    let replacementCount = 0;

    // Phase 1: Replace @usernames first to avoid partial matches
    for (const mapping of this.characterMappingsCache) {
      const realUsername = this.generateUsername(mapping.realName);
      const parodyUsername = this.generateUsername(mapping.parodyName);

      if (realUsername === parodyUsername) continue;

      const usernameRegex = new RegExp(
        `@${escapeRegex(realUsername)}\\b`,
        'gi'
      );

      if (usernameRegex.test(transformedText)) {
        transformedText = transformedText.replace(usernameRegex, (match) => {
          const matchedUsername = match.slice(1);
          const casedReplacement = this.preserveCase(
            matchedUsername,
            parodyUsername
          );
          characterMappingsResult[`@${realUsername}`] = `@${casedReplacement}`;
          replacementCount++;
          return `@${casedReplacement}`;
        });
      }
    }

    // Phase 2: Replace character and organization names in ONE pass.
    // A single longest-first alternation with non-consuming boundaries means:
    // - every occurrence is handled (adjacent names sharing a separator too),
    // - inserted parody text is never rescanned/re-replaced,
    // - existing parody names are matched as protected tokens and kept, so a
    //   parody name elsewhere in the text no longer blocks real-name
    //   replacement globally.
    const terms = this.buildNameTerms();
    if (terms.length > 0) {
      const termByLower = new Map(terms.map((t) => [t.term.toLowerCase(), t]));
      const regex = buildBoundedAlternation(
        terms.map((t) => t.term),
        'giu'
      );
      transformedText = transformedText.replace(regex, (match) => {
        const term = termByLower.get(match.toLowerCase());
        if (!term || term.replacement === null) return match;
        const casedReplacement = this.preserveCase(match, term.replacement);
        if (casedReplacement === match) return match;
        if (term.kind === 'character') {
          characterMappingsResult[term.term] = casedReplacement;
        } else {
          organizationMappingsResult[term.term] = casedReplacement;
        }
        replacementCount++;
        return casedReplacement;
      });
    }

    return {
      transformedText,
      characterMappings: characterMappingsResult,
      organizationMappings: organizationMappingsResult,
      replacementCount,
    };
  }

  /** Check if text contains any real names that should be replaced */
  async detectRealNames(text: string): Promise<string[]> {
    this.loadMappings();
    const foundNames: string[] = [];

    for (const term of this.buildNameTerms()) {
      if (term.replacement === null) continue;
      if (buildBoundedAlternation([term.term], 'iu').test(text)) {
        foundNames.push(term.term);
      }
    }

    return foundNames;
  }

  /**
   * Searchable name terms (real names/aliases with their replacement, plus
   * parody names as protected tokens with `replacement: null`), longest
   * first so multi-word names win over their parts. Earlier (higher
   * priority) mappings win on duplicate terms.
   */
  private buildNameTerms(): NameTerm[] {
    const byLower = new Map<string, NameTerm>();
    const add = (term: NameTerm) => {
      const key = term.term.toLowerCase();
      if (!term.term.trim() || byLower.has(key)) return;
      byLower.set(key, term);
    };
    const groups: Array<{
      kind: NameTerm['kind'];
      mappings: Array<CharacterMapping | OrganizationMapping>;
    }> = [
      { kind: 'character', mappings: this.characterMappingsCache },
      { kind: 'organization', mappings: this.organizationMappingsCache },
    ];
    for (const { kind, mappings } of groups) {
      for (const mapping of mappings) {
        for (const searchName of [mapping.realName, ...mapping.aliases]) {
          add({
            term: searchName,
            kind,
            replacement: this.getReplacementForTerm(
              searchName,
              mapping.realName,
              mapping.parodyName
            ),
          });
        }
      }
    }
    for (const [realName, parodyName] of Object.entries(CRYPTO_PARODY_NAMES)) {
      add({ term: realName, kind: 'organization', replacement: parodyName });
      add({ term: parodyName, kind: 'organization', replacement: null });
    }
    // Parody names are protected: real terms take precedence on an exact
    // case-insensitive collision because they were added first.
    for (const { kind, mappings } of groups) {
      for (const mapping of mappings) {
        add({ term: mapping.parodyName, kind, replacement: null });
        for (const searchName of mapping.aliases) {
          const parodyAlias = this.getReplacementForTerm(
            searchName,
            mapping.realName,
            mapping.parodyName
          );
          add({ term: parodyAlias, kind, replacement: null });
        }
      }
    }
    return [...byLower.values()].sort((a, b) => b.term.length - a.term.length);
  }

  async getCharacterMappings(): Promise<ActiveCharacterMapping[]> {
    this.loadMappings();
    return this.characterMappingsCache;
  }

  async getOrganizationMappings(): Promise<ActiveOrganizationMapping[]> {
    this.loadMappings();
    return this.organizationMappingsCache;
  }

  refreshCache(): void {
    this.initialized = false;
    StaticDataRegistry.clearCache();
  }
}

interface NameTerm {
  term: string;
  kind: 'character' | 'organization';
  /** null marks a protected (already-parody) token that is left unchanged */
  replacement: string | null;
}

/**
 * Alternation of terms bounded by non-consuming lookarounds: a term may not be
 * preceded by a letter or "@" (mentions are handled separately) nor followed
 * by a letter. Unicode-aware so accented names have real boundaries.
 */
function buildBoundedAlternation(terms: string[], flags: string): RegExp {
  const alternation = terms.map(escapeRegex).join('|');
  return new RegExp(`(?<![\\p{L}@])(?:${alternation})(?!\\p{L})`, flags);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Singleton instance
export const characterMappingService = new CharacterMappingService();
