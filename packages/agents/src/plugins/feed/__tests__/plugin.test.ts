import { describe, expect, test } from 'bun:test';
import { npcFeedPlugin } from '../npc';

describe('NPC Feed plugin', () => {
  test('declares the native provider set for hosted NPCs', () => {
    expect(npcFeedPlugin.providers?.map(({ name }) => name)).toEqual([
      'FEED_GOALS',
      'FEED_HEADLINES',
      'SHARED_CHAT_FACTS',
      'RECENT_RELEVANT_GROUP_CONTEXT',
      'LIVE_PLAYER_ROSTER',
      'AGENT_WORKING_MEMORY',
    ]);
    expect(npcFeedPlugin.evaluators?.map(({ name }) => name)).toEqual([
      'SHARED_CHAT_CONTEXT_EVALUATOR',
    ]);
    expect(npcFeedPlugin.actions ?? []).toEqual([]);
  });
});
