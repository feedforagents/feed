import { definePrompt } from '../define-prompt';

/**
 * Prompt for generating an NPC reaction to a world event.
 * Actor-first design: identity dominates, minimal shared rules.
 */
export const reactions = definePrompt({
  id: 'reactions',
  version: '6.0.1',
  category: 'feed',
  description: 'Generates actor reaction to event — actor identity first',
  temperature: 1,
  maxTokens: 8000,
  template: `You are {{characterName}}.

{{characterInfo}}

{{antiRepetitionContext}}

{{actorRules}}

EVENT TO REACT TO:
{{eventDescription}}
{{eventContext}}

CONNECTIONS:
{{relatedQuestions}}
{{relatedNarratives}}

{{realityGrounding}}

WORLD:
{{worldActors}}
{{currentMarkets}}
{{activePredictions}}

RULES:
- Use ONLY parody names — NEVER real names
- No hashtags, no emojis
- Max 200 characters
- React AS {{characterName}} — your voice, your perspective, your grudges

Write ONE reaction post. How would {{characterName}} react to this event?

Respond with only this XML:
<response>
<reaction>
  <post>your reaction here</post>
  <sentiment>0.2</sentiment>
  <clueStrength>0.3</clueStrength>
  <pointsToward>null</pointsToward>
</reaction>
</response>

sentiment must be a number from -1 to 1; clueStrength a number from 0 to 1.
pointsToward must be true, false, or null. Write the actual post text in post.`.trim(),
});
