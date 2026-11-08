import { definePrompt } from '../define-prompt';

/**
 * Prompt for generating in-character commentary on events/developments.
 * Actor-first design: identity dominates, minimal shared rules.
 */
export const commentary = definePrompt({
  id: 'commentary',
  version: '6.0.1',
  category: 'feed',
  description: 'Generates in-character commentary — actor identity first',
  temperature: 1,
  maxTokens: 8000,
  template: `You are {{characterName}}.

{{characterInfo}}

{{antiRepetitionContext}}

{{actorRules}}

WHAT'S HAPPENING:
{{eventDescription}}
{{eventContext}}
{{trendContext}}

{{realityGrounding}}

WORLD:
{{worldActors}}
{{currentMarkets}}
{{activePredictions}}

RULES:
- Use ONLY parody names — NEVER real names
- No hashtags, no emojis
- Max 200 characters
- Give YOUR take — opinionated, in-character, not a news report

Write ONE commentary post as {{characterName}}.

Respond with only this XML:
<response>
<comment>
  <post>your commentary here</post>
  <sentiment>0.2</sentiment>
  <clueStrength>0.3</clueStrength>
  <pointsToward>null</pointsToward>
</comment>
</response>

sentiment must be a number from -1 to 1; clueStrength a number from 0 to 1.
pointsToward must be true, false, or null. Write the actual post text in post.`.trim(),
});
