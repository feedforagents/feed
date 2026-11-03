import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { FeedGenerator, parseXML } from '@feed/engine';
import type {
  Actor,
  FeedPost,
  JsonValue,
  Organization,
  WorldEvent,
} from '@feed/shared';
import type {
  LLMGenerateJSONOptions,
  LLMJsonSchema,
} from '../../engine/src/llm/types';
import type { WorldContext } from '../../engine/src/prompts/world-context';
import type { ComprehensiveNPCContext } from '../../engine/src/utils/context-builder';

type TestableFeedGenerator = {
  llm:
    | {
        generateJSON: (
          prompt: string,
          schema?: LLMJsonSchema,
          options?: LLMGenerateJSONOptions
        ) => Promise<JsonValue>;
      }
    | undefined;
  worldContext: WorldContext;
  generateReplyContent: (actor: Actor, post: FeedPost) => Promise<string>;
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
  generateReactionForCharacter: (
    actor: Actor,
    event: WorldEvent,
    outcome: boolean,
    day: number
  ) => Promise<object | null>;
  getActorRelationships: (actorId: string) => Promise<string>;
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

describe('FeedGenerator event actor attribution', () => {
  afterEach(() => mock.restore());
  type CascadeGenerator = {
    organizations: Organization[];
    generateEventCascade: (
      day: number,
      event: WorldEvent,
      actors: Actor[],
      outcome: boolean
    ) => Promise<FeedPost[]>;
    generateReactionForCharacter: (actor: Actor) => Promise<{
      post: string;
      sentiment: number;
      clueStrength: number;
      pointsToward: null;
    } | null>;
    generateConspiracyForCharacter: (actor: Actor) => Promise<{
      post: string;
      sentiment: number;
      clueStrength: number;
      pointsToward: null;
    } | null>;
    generateCompanyPost: (
      org: Organization,
      event: WorldEvent,
      actor: Actor
    ) => Promise<{
      post: string;
      sentiment: number;
      clueStrength: number;
      pointsToward: null;
    }>;
    generateThread: () => Promise<[]>;
  };
  const alice: Actor = {
    id: 'alice',
    name: 'Alice',
    affiliations: ['company-a'],
  };
  const bob: Actor = { id: 'bob', name: 'Bob', affiliations: ['company-b'] };
  const companies: Organization[] = [
    {
      id: 'company-a',
      name: 'Company A',
      type: 'company',
      description: 'A',
      canBeInvolved: true,
    },
    {
      id: 'company-b',
      name: 'Company B',
      type: 'company',
      description: 'B',
      canBeInvolved: true,
    },
  ];
  const resultFor = (actor: Actor) => ({
    post: `post by ${actor.id}`,
    sentiment: 0,
    clueStrength: 0,
    pointsToward: null,
  });
  for (const drop of [null, 'alice'] as const) {
    test(`reaction posts and company affiliation follow their actor in reversed order, dropped=${drop}`, async () => {
      spyOn(Math, 'random').mockReturnValue(0);
      const generator = new FeedGenerator() as unknown as CascadeGenerator;
      generator.organizations = companies;
      generator.generateReactionForCharacter = async (actor) =>
        actor.id === drop ? null : resultFor(actor);
      const affiliations: string[] = [];
      generator.generateCompanyPost = async (org, _event, actor) => {
        affiliations.push(`${actor.id}:${org.id}`);
        return resultFor(actor);
      };
      generator.generateThread = async () => [];
      const generated = await generator.generateEventCascade(
        2,
        { ...event, actors: ['alice', 'bob'] },
        [alice, bob],
        false
      );
      const reactions = generated.filter(
        (post) => post.author === 'alice' || post.author === 'bob'
      );
      expect(reactions.map((post) => `${post.author}:${post.content}`)).toEqual(
        drop ? ['bob:post by bob'] : ['bob:post by bob', 'alice:post by alice']
      );
      expect(affiliations).toEqual(
        drop ? ['bob:company-b'] : ['bob:company-b', 'alice:company-a']
      );
    });
  }
  for (const drop of [null, 'alice'] as const) {
    test(`conspiracy posts follow their actor in reversed order, dropped=${drop}`, async () => {
      spyOn(Math, 'random').mockReturnValue(0).mockReturnValueOnce(0.75);
      const generator = new FeedGenerator() as unknown as CascadeGenerator;
      generator.generateConspiracyForCharacter = async (actor) =>
        actor.id === drop ? null : resultFor(actor);
      generator.generateThread = async () => [];
      const generated = await generator.generateEventCascade(
        2,
        { ...event, actors: [] },
        [
          { ...alice, personality: 'contrarian' },
          { ...bob, personality: 'contrarian' },
        ],
        false
      );
      expect(generated.map((post) => `${post.author}:${post.content}`)).toEqual(
        drop ? ['bob:post by bob'] : ['bob:post by bob', 'alice:post by alice']
      );
    });
  }
});

describe('FeedGenerator media batch attribution', () => {
  for (const firstContent of ['', 'reject me']) {
    test(`keeps the second media entity when the first item is ${firstContent ? 'rejected' : 'blank'}`, async () => {
      type MediaCascade = {
        organizations: Organization[];
        worldContext: WorldContext;
        llm: { generateJSON: () => Promise<JsonValue> };
        validatePostContent: (
          content: string,
          kind: string
        ) => { isValid: boolean; cleanContent: string; violations: string[] };
        generateEventCascade: (
          day: number,
          event: WorldEvent,
          actors: Actor[],
          outcome: boolean
        ) => Promise<FeedPost[]>;
      };
      const generator = new FeedGenerator() as unknown as MediaCascade;
      generator.organizations = [
        {
          id: 'media-a',
          name: 'First News',
          type: 'media',
          description: 'First outlet',
          canBeInvolved: true,
        },
        {
          id: 'media-b',
          name: 'Second News',
          type: 'media',
          description: 'Second outlet',
          canBeInvolved: true,
        },
      ];
      generator.worldContext = {
        worldActors: '',
        currentMarkets: '',
        activePredictions: '',
        recentTrades: '',
        currentDateTime: '2026-11-03T00:00:00Z',
        currentDate: '2026-11-03',
        currentTime: '00:00:00',
        currentYear: '2026',
        currentMonth: '11',
        currentDay: '3',
        realityGrounding: '',
        worldFacts: '',
      };
      if (firstContent) {
        generator.validatePostContent = (content) => ({
          isValid: content !== firstContent,
          cleanContent: content,
          violations:
            content === firstContent ? ['rejected by validation'] : [],
        });
      }
      generator.llm = {
        generateJSON: async () => ({
          posts: [
            {
              content: firstContent,
              sentiment: 0,
              clueStrength: 0,
              pointsToward: null,
            },
            {
              content: 'Second outlet reports the chip shipment arrived.',
              sentiment: 0,
              clueStrength: 0,
              pointsToward: null,
            },
          ],
        }),
      };
      const posts = await generator.generateEventCascade(
        2,
        { ...event, actors: [] },
        [],
        false
      );
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({
        author: 'media-b',
        authorName: 'Second News',
        content: 'Second outlet reports the chip shipment arrived.',
      });
    }, 8000);
  }
});

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

describe('FeedGenerator single-reply JSON contract', () => {
  const replyActor: Actor = {
    ...actor,
    description: 'An industry commentator.',
    ignoreTopics: ['astrology'],
  };
  const originalPost: FeedPost = {
    id: 'original-post',
    timestamp: '2026-11-03T00:00:00.000Z',
    author: 'original-author',
    authorName: 'Original Author',
    content: 'The chip shipment has arrived.',
  };
  const prepare = () => {
    const generator = new FeedGenerator() as unknown as TestableFeedGenerator;
    generator.worldContext = {
      worldActors: 'Commentator; Original Author',
      currentMarkets: '',
      activePredictions: '',
      recentTrades: '',
      currentDateTime: '2026-11-03T00:00:00.000Z',
      currentDate: '2026-11-03',
      currentTime: '00:00:00',
      currentYear: '2026',
      currentMonth: '11',
      currentDay: '3',
      realityGrounding: 'The chip shipment has arrived.',
      worldFacts: '',
    };
    return generator;
  };

  for (const [shape, json] of [
    ['flat', '{"post":"OpenAI   has receipts. #hype"}'],
    ['wrapped', '{"response":{"post":"OpenAI   has receipts. #hype"}}'],
  ]) {
    test(`single reply accepts parsed ${shape} JSON and preserves canonical postprocessing`, async () => {
      const generator = prepare();
      let calls = 0;
      generator.llm = {
        generateJSON: async (prompt, schema, options) => {
          calls++;
          expect(schema).toEqual({
            properties: { post: { type: 'string', pattern: '\\S' } },
            required: ['post'],
          });
          expect(options?.format).toBe('json');
          expect(options?.promptType).toBe('feed_generate_reply_content');
          expect(prompt).toContain('Max 200 characters');
          expect(prompt).not.toContain('<sentiment>');
          const example = prompt.match(/```json\n([\s\S]*?)\n```/)?.[1];
          expect(example).toBeDefined();
          expect(JSON.parse(example!)).toEqual({ post: 'your reply here' });
          return JSON.parse(json!) as JsonValue;
        },
      };

      expect(
        await generator.generateReplyContent(replyActor, originalPost)
      ).toBe('OpenAGI has receipts.');
      expect(calls).toBe(1);
    });
  }

  for (const json of [
    'null',
    '[]',
    '"plain text"',
    '{}',
    '{"post":null}',
    '{"post":42}',
    '{"post":{"text":"nested text"}}',
    '{"post":""}',
    '{"post":"  \\n "}',
    '{"response":null}',
    '{"response":{"post":false}}',
  ]) {
    test(`single reply rejects malformed parsed value ${json}`, async () => {
      const generator = prepare();
      generator.llm = {
        generateJSON: async () => JSON.parse(json) as JsonValue,
      };
      await expect(
        generator.generateReplyContent(replyActor, originalPost)
      ).rejects.toThrow('Reply response must contain a nonempty string post');
    });
  }

  test('single reply preserves the legacy no-model response', async () => {
    const generator = prepare();
    generator.llm = undefined;
    expect(await generator.generateReplyContent(replyActor, originalPost)).toBe(
      'Interesting point.'
    );
  });
});

describe('FeedGenerator schema-shaped single-post contracts', () => {
  const body =
    '<post>The chip shipment is here. Show us the receipts.</post><sentiment>0.25</sentiment><clueStrength>0.3</clueStrength><pointsToward>null</pointsToward>';
  const parse = (xml: string): JsonValue => {
    const parsed = parseXML(xml);
    if (!parsed.success || parsed.data === undefined)
      throw new Error('Invalid test XML');
    return parsed.data;
  };
  const prepare = () => {
    const generator = new FeedGenerator() as unknown as TestableFeedGenerator;
    generator.buildRichCharacterContext = async () => ({
      characterInfo: 'An industry commentator.',
      comprehensiveContext: {
        personalEvents: [],
        recentEvents: [],
        previousPosts: [],
      },
    });
    generator.getActorRelationships = async () =>
      'No relationship history is available.';
    return generator;
  };

  for (const [method, tag, examplePost] of [
    ['generateCommentaryForCharacter', 'comment', 'your commentary here'],
    ['generateReactionForCharacter', 'reaction', 'your reaction here'],
  ] as const) {
    for (const [shape, xml] of [
      ['item wrapper', `<response><${tag}>${body}</${tag}></response>`],
      [
        'nested response wrapper',
        `<envelope><response><${tag}>${body}</${tag}></response></envelope>`,
      ],
    ]) {
      test(`${method} retains a schema-shaped parsed ${shape} on the first attempt`, async () => {
        const response = parse(xml!);
        const generator = prepare();
        let calls = 0;
        let prompt = '';
        generator.llm = {
          generateJSON: async (value, schema) => {
            calls++;
            prompt = value;
            expect(schema?.required).toEqual([tag]);
            return response;
          },
        };
        const result =
          method === 'generateReactionForCharacter'
            ? await generator.generateReactionForCharacter(
                actor,
                event,
                false,
                2
              )
            : await generator.generateCommentaryForCharacter(actor, event, 2);
        expect(result).toEqual({
          post: 'The chip shipment is here. Show us the receipts.',
          sentiment: 0.25,
          clueStrength: 0.3,
          pointsToward: null,
        });
        expect(calls).toBe(1);
        const format = prompt.match(/<response>[\s\S]*<\/response>/)?.[0];
        expect(format).toBeDefined();
        expect(parse(format!)).toEqual({
          [tag]: {
            post: examplePost,
            sentiment: 0.2,
            clueStrength: 0.3,
            pointsToward: null,
          },
        });
      });
    }

    test(`${method} still rejects a non-string post before accepting valid parsed text`, async () => {
      const generator = prepare();
      const replies = [
        parse(
          `<response><${tag}><post><text>Not plain post text</text></post></${tag}></response>`
        ),
        parse(`<response><${tag}>${body}</${tag}></response>`),
      ];
      let calls = 0;
      generator.llm = {
        generateJSON: async () => replies[Math.min(calls++, 1)]!,
      };
      const result =
        method === 'generateReactionForCharacter'
          ? await generator.generateReactionForCharacter(actor, event, false, 2)
          : await generator.generateCommentaryForCharacter(actor, event, 2);
      expect(result).toEqual({
        post: 'The chip shipment is here. Show us the receipts.',
        sentiment: 0.25,
        clueStrength: 0.3,
        pointsToward: null,
      });
      expect(calls).toBe(2);
    });
  }
});
