import { describe, expect, test } from 'bun:test';
import { FeedGenerator } from '@feed/engine';
import type { Actor, WorldEvent } from '@feed/shared';
import type { ComprehensiveNPCContext } from '../../engine/src/utils/context-builder';

type TestableFeedGenerator = {
  llm: { generateJSON: (prompt: string) => Promise<never> };
  trendContext: string;
  buildRichCharacterContext: () => Promise<{
    characterInfo: string;
    comprehensiveContext: ComprehensiveNPCContext;
  }>;
  generateCommentaryForCharacter: (
    actor: Actor,
    event: WorldEvent,
    day: number
  ) => Promise<object | null>;
  generateConspiracyForCharacter: (
    actor: Actor,
    event: WorldEvent,
    day: number
  ) => Promise<object | null>;
};

const actor: Actor = { id: 'commentator', name: 'Commentator' };
const event: WorldEvent = {
  id: 'event',
  day: 2,
  type: 'announcement',
  description: 'The chip shipment has arrived.',
  actors: [actor.id],
  visibility: 'public',
};

describe('FeedGenerator event prompt context', () => {
  for (const method of [
    'generateCommentaryForCharacter',
    'generateConspiracyForCharacter',
  ] as const) {
    for (const hasNarrative of [true, false]) {
      test(`${method} renders actual context with narrative=${hasNarrative}`, async () => {
        const generator =
          new FeedGenerator() as unknown as TestableFeedGenerator;
        const stop = new Error('Prompt captured before inference');
        let prompt = '';
        generator.llm = {
          generateJSON: async (value) => {
            prompt = value;
            throw stop;
          },
        };
        generator.trendContext = 'Trending: semiconductor supply';
        generator.buildRichCharacterContext = async () => ({
          characterInfo: 'An industry commentator.',
          comprehensiveContext: {
            personalEvents: [],
            recentEvents: [],
            previousPosts: [],
            ongoingNarratives: hasNarrative
              ? 'Supply is recovering.'
              : undefined,
          },
        });

        await expect(generator[method](actor, event, 2)).rejects.toBe(stop);
        expect(prompt).toContain(event.description);
        expect(prompt).not.toContain('{{eventContext}}');
        if (method === 'generateCommentaryForCharacter') {
          expect(prompt).toContain(
            `${event.description}\nCommentator is directly involved in this event.${hasNarrative ? '\nSupply is recovering.' : ''}`
          );
          expect(prompt).toContain('Trending: semiconductor supply');
        } else {
          expect(prompt).toContain(
            `${event.description}\n${hasNarrative ? 'Supply is recovering.' : 'No ongoing narrative context is available.'}`
          );
        }
      });
    }
  }
});
