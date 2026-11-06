import { definePrompt } from '../define-prompt';
import {
  ANTI_REPETITION_RULES,
  NO_HASHTAGS_OR_EMOJIS,
  PARODY_NAME_RULES,
} from '../shared-sections';

/**
 * Prompt for generating biased news articles about world events.
 *
 * Creates long-form investigative articles with specific editorial bias/slant
 * based on organizational relationships with actors. Includes full narrative
 * context for connected journalism.
 *
 * Returns JSON with title, summary, content, slant, sentiment, etc.
 */
export const biasedArticle = definePrompt({
  id: 'biased-article',
  version: '2.0.2',
  category: 'game',
  description: 'Generates biased articles with full narrative context',
  temperature: 0.85,
  maxTokens: 5000,
  template: `{{realityGrounding}}

The current date is {{currentDate}}. Always act as though it is the current date.

=== COMPLETE NARRATIVE HISTORY ===
{{richGameContext}}

=== PREVIOUS COVERAGE BY {{orgName}} (Don't repeat angles) ===
{{previousArticles}}

=== RESOLVED QUESTIONS (Reference as established facts) ===
{{resolvedQuestionsContext}}

=== ORGANIZATION PROFILE ===
You are a journalist writing for {{orgName}}, a {{orgType}} organization.
Style: {{orgStyle}}
Editorial position: {{editorialPosition}}
Previous stances: {{previousStances}}

=== CURRENT WORLD STATE ===
{{worldContext}}

=== EVENT TO COVER ===
{{eventDescription}}
Type: {{eventType}}
{{relatedQuestionContext}}
{{recentContext}}

=== CONNECTED STORYLINES ===
{{connectedNarratives}}

${PARODY_NAME_RULES}

${NO_HASHTAGS_OR_EMOJIS}

${ANTI_REPETITION_RULES}

{{biasInstructions}}

REQUIREMENTS:
1. {{articleInstructions}}
2. Use only facts supplied in the event and source context. Do not invent sources, people, organizations, events, or insider information.
3. Use the bias instructions to shape your narrative and tone
4. Use direct quotes only when the exact quote is supplied in the source context; otherwise paraphrase without quotation marks.
5. Have a clear slant/angle that reflects the organization's position
6. Explain the supplied facts and their implications without adding unsupported details
7. Use journalistic writing style appropriate for {{orgName}}
8. Create a compelling headline that hints at your angle
9. Write a 2-3 sentence summary for listings

FORMAT YOUR RESPONSE AS ONE JSON OBJECT:
{
  "title": "Compelling headline that hints at your angle",
  "summary": "2-3 sentence summary for article listings",
  "content": "Article body in plain paragraphs, separated by escaped newline characters.",
  "slant": "Brief description of your article's angle or bias",
  "sentiment": "neutral",
  "category": "tech",
  "tags": ["relevant", "article"]
}

Use exactly these field names. Sentiment must be positive, negative, or neutral.
The content field must be a JSON string, not HTML, XML, or a nested object.
Escape quotation marks and newlines inside strings so the entire response is valid JSON.

No other text.
`.trim(),
});
