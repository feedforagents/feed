import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { GameGenerator, parseXML } from '@feed/engine';
import type {
  ActorConnection,
  Question,
  SelectedActor,
  WorldEvent,
} from '@feed/shared';
import * as gameContextBuilder from '../../engine/src/utils/game-context-builder';

type EventRequest = {
  eventNumber: number;
  type: WorldEvent['type'];
  actors: SelectedActor[];
  questionId: number;
};
type TestableGenerator = {
  llm: {
    generateJSON: (
      prompt: string,
      schema: { required?: string[] } | undefined,
      options: { temperature?: number; maxTokens?: number; promptType?: string }
    ) => Promise<unknown>;
  };
  generateDayEventsBatch: (
    day: number,
    requests: EventRequest[],
    questions: Question[],
    fullContext: string,
    states: Map<string, { luck: string; mood: number }>,
    connections: ActorConnection[],
    previousDays: []
  ) => Promise<
    Array<{
      eventNumber: number;
      event: string;
      pointsToward: 'YES' | 'NO' | null;
    }>
  >;
};

function generatorFor(response: unknown) {
  spyOn(gameContextBuilder, 'buildRichGameContext').mockResolvedValue(
    {} as never
  );
  spyOn(gameContextBuilder, 'formatRichGameContext').mockReturnValue('');
  const instance = new GameGenerator(
    'test-key'
  ) as unknown as TestableGenerator;
  const calls: Array<{
    prompt: string;
    schema: { required?: string[] } | undefined;
    options: { temperature?: number; maxTokens?: number; promptType?: string };
  }> = [];
  instance.llm = {
    generateJSON: async (prompt, schema, options) => {
      calls.push({ prompt, schema, options });
      return response;
    },
  };
  return { instance, calls };
}

const question: Question = {
  id: 'db-77',
  questionNumber: 77,
  text: 'Will the launch reach orbit?',
  scenario: 1,
  outcome: true,
  rank: 1,
};

function requests(count: number): EventRequest[] {
  return Array.from({ length: count }, (_, index) => ({
    eventNumber: index,
    type: 'announcement',
    actors: [],
    questionId: 77,
  }));
}

async function generate(response: unknown, count: number) {
  const { instance } = generatorFor(response);
  return instance.generateDayEventsBatch(
    1,
    requests(count),
    [question],
    'context',
    new Map(),
    [],
    []
  );
}

describe('generated day event contract', () => {
  afterEach(() => mock.restore());

  test('preserves a single actual XML description and normalizes YES', async () => {
    const parsed = parseXML(
      '<response><events><event><eventNumber>1</eventNumber><description>AIlon Musk announces a launch.</description><pointsToward>yes</pointsToward></event></events></response>'
    );
    expect(parsed.success).toBe(true);
    const { instance, calls } = generatorFor(parsed.data);
    const events = await instance.generateDayEventsBatch(
      1,
      requests(1),
      [question],
      'context',
      new Map(),
      [],
      []
    );
    expect(events).toEqual([
      {
        eventNumber: 1,
        event: 'AIlon Musk announces a launch.',
        pointsToward: 'YES',
      },
    ]);
    expect(calls[0]?.schema?.required).toEqual(['events']);
    expect(calls[0]?.options).toMatchObject({
      temperature: 0.9,
      maxTokens: 15000,
      promptType: 'generate_day_events',
    });
    expect(calls[0]?.prompt).not.toContain('<relatedQuestion>');
    expect(calls[0]?.prompt).not.toContain('<buildsOn>');
    expect(calls[0]?.prompt).not.toContain('<advancesNarrative>');
    expect(calls[0]?.prompt).not.toContain(
      '<pointsToward>YES|NO|NEUTRAL</pointsToward>'
    );
  });

  test('uses questionNumber to include the actual question text in the prompt', async () => {
    const { instance, calls } = generatorFor({
      events: {
        event: {
          eventNumber: 1,
          description: 'A launch.',
          pointsToward: 'YES',
        },
      },
    });
    await instance.generateDayEventsBatch(
      1,
      requests(1),
      [question],
      'context',
      new Map(),
      [],
      []
    );
    expect(calls[0]?.prompt).toContain(
      'Related to: Will the launch reach orbit?'
    );
  });

  test('uses the ID only when the question number is absent', async () => {
    const { instance, calls } = generatorFor({
      events: {
        event: {
          eventNumber: 1,
          description: 'A launch.',
          pointsToward: 'YES',
        },
      },
    });
    const legacyQuestion = { ...question, id: '77', questionNumber: undefined };
    await instance.generateDayEventsBatch(
      1,
      requests(1),
      [legacyQuestion],
      'context',
      new Map(),
      [],
      []
    );
    expect(calls[0]?.prompt).toContain(
      'Related to: Will the launch reach orbit?'
    );
  });

  test('rejects an unmatched question instead of inventing context', async () => {
    const { instance, calls } = generatorFor({});
    await expect(
      instance.generateDayEventsBatch(
        1,
        requests(1),
        [],
        'context',
        new Map(),
        [],
        []
      )
    ).rejects.toThrow(/question/i);
    expect(calls).toHaveLength(0);
  });

  test('matches repeated XML entries to requested positions even when returned out of order', async () => {
    const parsed = parseXML(
      '<response><events><event><eventNumber>2</eventNumber><description>The second event.</description><pointsToward>NEUTRAL</pointsToward></event><event><eventNumber>1</eventNumber><description>The first event.</description><pointsToward>NO</pointsToward></event></events></response>'
    );
    expect(parsed.success).toBe(true);
    expect(await generate(parsed.data, 2)).toEqual([
      { eventNumber: 1, event: 'The first event.', pointsToward: 'NO' },
      { eventNumber: 2, event: 'The second event.', pointsToward: null },
    ]);
  });

  test('maps known real organization names in generated event text', async () => {
    const events = await generate(
      {
        events: {
          event: {
            eventNumber: 1,
            description: 'OpenAI announces a launch.',
            pointsToward: 'NO',
          },
        },
      },
      1
    );
    expect(events[0]?.event).toBe('OpenAGI announces a launch.');
  });

  test('accepts the legacy event field without fabricating its description', async () => {
    expect(
      await generate(
        {
          response: {
            events: [
              {
                eventNumber: 1,
                event: 'Existing event text.',
                pointsToward: null,
              },
            ],
          },
        },
        1
      )
    ).toEqual([
      { eventNumber: 1, event: 'Existing event text.', pointsToward: null },
    ]);
  });

  test('rejects malformed XML instead of fabricating an event', async () => {
    const parsed = parseXML(
      '<response><events><event><description>Bad</event></events></response>'
    );
    expect(parsed.success).toBe(false);
    await expect(generate(parsed.data, 1)).rejects.toThrow(/invalid.*event/i);
  });

  const invalid = [
    ['missing events', {}],
    [
      'missing description',
      { events: { event: { eventNumber: 1, pointsToward: 'YES' } } },
    ],
    [
      'empty description',
      {
        events: {
          event: { eventNumber: 1, description: '  ', pointsToward: 'YES' },
        },
      },
    ],
    [
      'missing signal',
      { events: { event: { eventNumber: 1, description: 'Event' } } },
    ],
    [
      'invalid signal',
      {
        events: {
          event: {
            eventNumber: 1,
            description: 'Event',
            pointsToward: 'MAYBE',
          },
        },
      },
    ],
    ['wrong count', { events: { event: [] } }],
    [
      'invalid event number',
      {
        events: {
          event: { eventNumber: 2, description: 'Event', pointsToward: 'NO' },
        },
      },
    ],
  ] as const;
  for (const [label, response] of invalid) {
    test(`rejects ${label}`, async () => {
      await expect(generate(response, 1)).rejects.toThrow(/invalid.*event/i);
    });
  }
  test('rejects duplicate event numbers', async () => {
    await expect(
      generate(
        {
          events: {
            event: [
              { eventNumber: 1, description: 'First.', pointsToward: 'YES' },
              { eventNumber: 1, description: 'Second.', pointsToward: 'NO' },
            ],
          },
        },
        2
      )
    ).rejects.toThrow(/invalid.*event/i);
  });
});
