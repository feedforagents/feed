import { describe, expect, test } from 'bun:test';
import { GameGenerator } from '@feed/engine';
import type {
  ActorConnection,
  GroupChat,
  Scenario,
  SelectedActor,
} from '@feed/shared';

type TestableGameGenerator = {
  llm: { generateJSON: (prompt: string) => Promise<{ name: string }> };
  createGroupChats: (
    actors: {
      mains: SelectedActor[];
      supporting: SelectedActor[];
      extras: SelectedActor[];
    },
    connections: ActorConnection[],
    scenarios: Scenario[]
  ) => Promise<GroupChat[]>;
};

function actor(id: string, tier: SelectedActor['tier']): SelectedActor {
  return {
    id,
    name: id,
    tier,
    role: 'Founder',
    domain: ['technology'],
    initialLuck: 'medium',
    initialMood: 0,
  };
}

describe('GameGenerator group chat naming context', () => {
  test('includes previously generated names and the actual scenario in each naming prompt', async () => {
    const generator = new GameGenerator(
      'test-key'
    ) as unknown as TestableGameGenerator;
    const prompts: string[] = [];
    generator.llm = {
      generateJSON: async (prompt) => {
        prompts.push(prompt);
        return { name: `chat ${prompts.length}` };
      },
    };
    const scenarios: Scenario[] = [
      {
        id: 1,
        title: 'Market shift',
        description: 'A chip shortage unsettles markets.',
        mainActors: ['alice'],
        theme: 'technology',
      },
    ];

    const chats = await generator.createGroupChats(
      {
        mains: [actor('alice', 'S_TIER'), actor('bob', 'S_TIER')],
        supporting: [actor('carol', 'A_TIER')],
        extras: [],
      },
      [],
      scenarios
    );

    expect(chats.map((chat) => chat.name)).toEqual([
      'chat 1',
      'chat 2',
      'chat 3',
    ]);
    expect(prompts[0]).toContain('No groups have been named yet.');
    expect(prompts[1]).toContain('- chat 1');
    expect(prompts[2]).toContain('- chat 1\n- chat 2');
    for (const prompt of prompts) {
      expect(prompt).toContain(
        'Market shift: A chip shortage unsettles markets.'
      );
      expect(prompt).not.toContain('{{existingGroupNames}}');
      expect(prompt).not.toContain('{{ongoingNarratives}}');
    }
  });

  test('states that a fresh genesis game has no ongoing narratives', async () => {
    const generator = new GameGenerator(
      'test-key'
    ) as unknown as TestableGameGenerator;
    let prompt = '';
    generator.llm = {
      generateJSON: async (value) => {
        prompt = value;
        return { name: 'genesis chat' };
      },
    };

    await generator.createGroupChats(
      { mains: [actor('alice', 'S_TIER')], supporting: [], extras: [] },
      [],
      []
    );

    expect(prompt).toContain(
      'No ongoing narratives yet; the game has not started.'
    );
  });
});
