/**
 * Content Quality Gate
 *
 * Validates LLM-generated content before it's written to the database.
 * Sits at the write boundary for parodyHeadlines, worldFacts, and articles —
 * content that propagates into every generation prompt via
 * {{worldFactsContext}} in shared-sections.ts.
 *
 * Three checks, cheapest first:
 *  1. Structure — degenerate output (empty, too short/long, verbatim copy)
 *  2. Entity   — invented proper nouns not in StaticDataRegistry
 *  3. Grounding — source-relative validation (does output relate to input?)
 *
 * Replaces the previous ban-list approach (content-contamination-filter.ts)
 * with source-grounding checks that catch ANY hallucination, not just
 * previously-seen contamination terms.
 */

import { logger } from '@feed/shared';
import {
  checkEntityConsistency,
  clearKnownNamesCache,
  validateCoherence,
  validateGrounding,
} from './content-grounding-validator';

// Re-export for convenience — the canonical implementation is in content-grounding-validator.ts
export { clearKnownNamesCache };

export interface ContentQualityResult {
  passed: boolean;
  score: number; // 0–1 composite
  reasons: string[]; // failure reasons (empty if passed)
}

/**
 * Content Quality Gate — stateless validation service.
 *
 * Methods are static because the gate has no per-instance state.
 * All data comes from StaticDataRegistry (in-memory) and the
 * embedding client (lazy-init singleton).
 */
export class ContentQualityGate {
  // ─── Public API ──────────────────────────────────────────────

  /**
   * Validate a parody headline before inserting into parodyHeadlines.
   * Has source text (originalTitle) → runs grounding check.
   */
  static async validateParody(
    originalTitle: string,
    parodyTitle: string,
    parodyContent?: string
  ): Promise<ContentQualityResult> {
    const reasons: string[] = [];
    const scores: number[] = [];

    // 1. Structure
    const structure = this.checkStructure(parodyTitle, {
      minLength: 10,
      maxLength: 500,
      original: originalTitle,
    });
    scores.push(structure.score);
    if (!structure.passed) reasons.push(...structure.reasons);

    // 2. Entity allowlist
    const entity = checkEntityConsistency(parodyTitle);
    scores.push(entity.score);
    if (!entity.passed) reasons.push(...entity.reasons);

    // 3. Grounding: parody should stay topically related to original.
    // Skipped (cheapest-first) when the structure is already invalid, since
    // grounding may call the embedding API.
    if (structure.passed) {
      const grounding = await validateGrounding(originalTitle, parodyTitle);
      scores.push(grounding.confidence);
      if (!grounding.grounded) reasons.push(...grounding.reasons);
    }

    // If parody has content body, check its coherence too
    if (parodyContent) {
      const contentCoherence = validateCoherence(parodyContent);
      scores.push(contentCoherence.confidence);
      if (!contentCoherence.grounded) reasons.push(...contentCoherence.reasons);
    }

    const compositeScore =
      scores.length > 0
        ? scores.reduce((sum, s) => sum + s, 0) / scores.length
        : 0;

    const passed = reasons.length === 0;

    logger[passed ? 'debug' : 'warn'](
      `Parody ${passed ? 'passed' : 'failed'} quality gate`,
      {
        originalTitle,
        parodyTitle,
        score: compositeScore.toFixed(2),
        ...(reasons.length > 0 && { reasons }),
      },
      'ContentQualityGate'
    );

    return { passed, score: compositeScore, reasons };
  }

  /**
   * Validate a world fact before inserting into worldFacts.
   *
   * With sourceContext: runs grounding check (fact should relate to source).
   * Without sourceContext: runs coherence check (catches hallucination signals).
   */
  static async validateWorldFact(
    factText: string,
    sourceContext?: string
  ): Promise<ContentQualityResult> {
    const reasons: string[] = [];
    const scores: number[] = [];

    // 1. Structure
    const structure = this.checkStructure(factText, {
      minLength: 15,
      maxLength: 1000,
    });
    scores.push(structure.score);
    if (!structure.passed) reasons.push(...structure.reasons);

    // 2. Entity allowlist
    const entity = checkEntityConsistency(factText);
    scores.push(entity.score);
    if (!entity.passed) reasons.push(...entity.reasons);

    // 3. Source-relative or coherence check. Embedding-backed grounding is
    // skipped (cheapest-first) when the structure is already invalid.
    if (sourceContext) {
      if (structure.passed) {
        const grounding = await validateGrounding(sourceContext, factText);
        scores.push(grounding.confidence);
        if (!grounding.grounded) reasons.push(...grounding.reasons);
      }
    } else {
      const coherence = validateCoherence(factText);
      scores.push(coherence.confidence);
      if (!coherence.grounded) reasons.push(...coherence.reasons);
    }

    const compositeScore =
      scores.length > 0
        ? scores.reduce((sum, s) => sum + s, 0) / scores.length
        : 0;

    const passed = reasons.length === 0;

    logger[passed ? 'debug' : 'warn'](
      `World fact ${passed ? 'passed' : 'failed'} quality gate`,
      {
        factText: factText.substring(0, 100),
        score: compositeScore.toFixed(2),
        ...(reasons.length > 0 && { reasons }),
      },
      'ContentQualityGate'
    );

    return { passed, score: compositeScore, reasons };
  }

  /**
   * Validate an article before publishing.
   * Has source context (worldContext, event descriptions) → runs grounding check.
   */
  static async validateArticle(
    articleText: string,
    sourceContext: string
  ): Promise<ContentQualityResult> {
    const reasons: string[] = [];
    const scores: number[] = [];

    // 1. Structure
    const structure = this.checkStructure(articleText, {
      minLength: 100,
      maxLength: 15000,
    });
    scores.push(structure.score);
    if (!structure.passed) reasons.push(...structure.reasons);

    // 2. Entity allowlist
    const entity = checkEntityConsistency(articleText, sourceContext);
    scores.push(entity.score);
    if (!entity.passed) reasons.push(...entity.reasons);

    // 3. Grounding: article should relate to its source context (skipped
    // when the structure is already invalid — avoids embedding calls)
    if (structure.passed) {
      const grounding = await validateGrounding(sourceContext, articleText);
      scores.push(grounding.confidence);
      if (!grounding.grounded) reasons.push(...grounding.reasons);
    }

    const compositeScore =
      scores.length > 0
        ? scores.reduce((sum, s) => sum + s, 0) / scores.length
        : 0;

    const passed = reasons.length === 0;

    logger[passed ? 'debug' : 'warn'](
      `Article ${passed ? 'passed' : 'failed'} quality gate`,
      {
        articlePreview: articleText.substring(0, 100),
        score: compositeScore.toFixed(2),
        ...(reasons.length > 0 && { reasons }),
      },
      'ContentQualityGate'
    );

    return { passed, score: compositeScore, reasons };
  }

  // ─── Individual Checks ───────────────────────────────────────

  /**
   * Check structural validity — catches degenerate LLM output.
   */
  private static checkStructure(
    text: string,
    opts: { minLength: number; maxLength: number; original?: string }
  ): { passed: boolean; score: number; reasons: string[] } {
    const reasons: string[] = [];

    const trimmed = text.trim();
    if (trimmed.length < opts.minLength) {
      reasons.push(`Too short (${trimmed.length} < ${opts.minLength})`);
    }
    if (trimmed.length > opts.maxLength) {
      reasons.push(`Too long (${trimmed.length} > ${opts.maxLength})`);
    }

    // Verbatim copy detection
    if (opts.original) {
      const normalizedOriginal = opts.original.toLowerCase().trim();
      const normalizedText = trimmed.toLowerCase();
      if (normalizedText === normalizedOriginal) {
        reasons.push('Verbatim copy of original');
      }
    }

    const score = reasons.length === 0 ? 1 : 0;
    return { passed: reasons.length === 0, score, reasons };
  }
}
