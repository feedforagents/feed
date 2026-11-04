import { definePrompt } from '../define-prompt';

/**
 * Prompt for ranking questions by dramatic potential and entertainment value.
 *
 * Evaluates and ranks prediction market questions based on their dramatic
 * potential, entertainment value, and narrative impact. Used to select
 * the best questions for gameplay. Includes full context for narrative-aware ranking.
 *
 * Returns XML with ranked questions (1 = best, N = worst).
 */
export const questionRankings = definePrompt({
  id: 'question-rankings',
  version: '3.0.0',
  category: 'game',
  description: 'Ranks questions with narrative context',
  temperature: 0.5,
  maxTokens: 4000,
  template: `{{realityGrounding}}

The current date is {{currentDate}}. Always act as though it is the current date.

=== NARRATIVE CONTEXT ===
{{richGameContext}}

=== RESOLVED QUESTIONS (What's been covered) ===
{{resolvedQuestionsContext}}

=== ONGOING NARRATIVES (What's interesting now) ===
{{ongoingNarrativesContext}}

=== CURRENT PHASE ===
{{phaseContext}}

=== QUESTIONS TO RANK ===
{{questionsList}}

=== RANKING CRITERIA ===
Rank by dramatic potential and entertainment value (1 = best, {{questionCount}} = worst).

Consider:
1. Connection to ongoing narratives (higher = better)
2. Distinctness from resolved questions (unique = better)
3. Phase appropriateness (matches current phase = better)
4. Dramatic potential (high stakes, uncertainty)
5. Entertainment value (satirical, engaging)

Return exactly {{questionCount}} ranking entries: questionId is the 1-based number
shown in the question list, and both questionId and rank must each use every
integer from 1 through {{questionCount}} exactly once. Close every XML tag.
Return only questionId and rank in this XML structure:
<response>
  <rankings>
    <ranking>
      <questionId>1</questionId>
      <rank>1</rank>
    </ranking>
  </rankings>
</response>

No other text.
`.trim(),
});
