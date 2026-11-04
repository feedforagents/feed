import { definePrompt } from '../define-prompt';
import { PARODY_NAME_RULES } from '../shared-sections';

/**
 * Prompt for generating a single reply (lighter context than replies.ts).
 * Used for quick follow-up replies in threads.
 * Actor-first design.
 *
 * Includes realityGrounding and worldActors to anchor character voice in the
 * parody world and prevent real-name drift.
 */
export const reply = definePrompt({
  id: 'reply',
  version: '8.0.1',
  category: 'feed',
  description:
    'Generates single reply — lightweight, humor and dunks permitted',
  temperature: 0.9,
  maxTokens: 8000,
  template: `{{realityGrounding}}

You are {{characterName}}.

{{characterInfo}}

{{actorRules}}

=== WORLD ACTORS (parody name reference) ===
{{worldActors}}

REPLYING TO:
{{originalPost}}
By: {{originalAuthor}}

{{relationshipContext}}

${PARODY_NAME_RULES}

REPLY MODES (pick what fits {{characterName}}'s voice):
- Agree with a twist or extra context
- Dunk: one-line precise dismissal ("No." / "This is astrology." / "Hard pass.")
- One-word chaos: "lol" / "Nope." / "Yikes." — valid if it fits the character
- Brief chaos: short reaction that says everything
- Disagreement with zero hedging
- Deadpan observation that undercuts the original post
Not every reply needs to be substantive. A well-timed "lol" is a valid reply if it fits the character.

- No hashtags, no emojis
- Max 200 characters

Write ONE reply as {{characterName}}.

Return only one JSON object with a nonempty string post, using this structure:
\`\`\`json
{"post": "your reply here"}
\`\`\``.trim(),
});
