import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { GameGenerator, parseXML } from '@feed/engine';
import type {
  DayTimeline,
  GroupChat,
  Question,
  SelectedActor,
  WorldEvent,
} from '@feed/shared';
import * as gameContextBuilder from '../../engine/src/utils/game-context-builder';

type Generator = {
  llm: {
    generateJSON: (
      prompt: string,
      schema?: { required?: string[] }
    ) => Promise<unknown>;
  };
  generateDayGroupMessagesBatch: (
    day: number,
    events: WorldEvent[],
    groups: GroupChat[],
    actors: SelectedActor[],
    previous: DayTimeline[],
    states: Map<string, { luck: string; mood: number }>,
    connections: [],
    scenarios: [],
    questions: [],
    fullContext: string
  ) => Promise<
    Record<
      string,
      Array<{ from: string; message: string; clueStrength: number }>
    >
  >;
  generateResolutionEvent: (
    q: Question,
    actors: SelectedActor[],
    day: number,
    previous: DayTimeline[]
  ) => Promise<WorldEvent>;
  generateResolution: (
    questions: Question[],
    days: DayTimeline[]
  ) => {
    outcomes: Array<{ questionId: string | number; keyEvents: string[] }>;
  };
  generateDay: (
    day: number,
    actors: {
      mains: SelectedActor[];
      supporting: SelectedActor[];
      extras: SelectedActor[];
    },
    questions: Question[],
    scenarios: [],
    groups: [],
    previous: DayTimeline[],
    states: Map<string, { luck: string; mood: number }>,
    date: string,
    connections: []
  ) => Promise<DayTimeline>;
  generateDayEventsBatch: (...args: never[]) => Promise<[]>;
  feedGenerator: {
    setActorStates: () => void;
    setRelationships: () => void;
    setActorGroupContexts: () => void;
    generateDayFeed: () => Promise<[]>;
  };
  generateResolutionEventOriginal?: Generator['generateResolutionEvent'];
};
const question: Question = {
  id: 'db-77',
  questionNumber: 77,
  text: 'Will the launch happen?',
  scenario: 1,
  outcome: true,
  rank: 1,
};
const actors = [
  { id: 'alice', name: 'Alice', role: 'main' },
  { id: 'bob', name: 'Bob', role: 'supporting' },
] as SelectedActor[];
const groups: GroupChat[] = [
  {
    id: 'alpha-id',
    name: 'Alpha',
    theme: 'First',
    admin: 'alice',
    members: ['alice'],
  },
  {
    id: 'beta-id',
    name: 'Beta',
    theme: 'Second',
    admin: 'bob',
    members: ['bob'],
  },
];
const dayWithEvent: DayTimeline = {
  day: 1,
  summary: '',
  events: [
    {
      id: 'e',
      day: 1,
      type: 'announcement',
      actors: [],
      description: 'Earlier launch evidence.',
      relatedQuestion: 77,
      pointsToward: 'YES',
      visibility: 'public',
    },
  ],
  groupChats: {},
  feedPosts: [],
  luckChanges: [],
  moodChanges: [],
};
function makeGenerator(response: unknown) {
  spyOn(gameContextBuilder, 'buildRichGameContext').mockResolvedValue(
    {} as never
  );
  spyOn(gameContextBuilder, 'formatRichGameContext').mockReturnValue('');
  const instance = new GameGenerator('test-key') as unknown as Generator;
  const calls: string[] = [];
  instance.llm = {
    generateJSON: async (prompt) => {
      calls.push(prompt);
      return response;
    },
  };
  return { instance, calls };
}
function xmlEvents(groupId = 'alpha-id', actorId = 'alice') {
  const parsed = parseXML(
    `<response><groups><group><groupId>beta-id</groupId><messages><message><actorId>bob</actorId><content>Second message</content></message></messages></group><group><groupId>${groupId}</groupId><messages><message><actorId>${actorId}</actorId><content>First message</content></message></messages></group></groups></response>`
  );
  expect(parsed.success).toBe(true);
  return parsed.data;
}
async function groupBatch(instance: Generator) {
  return instance.generateDayGroupMessagesBatch(
    1,
    dayWithEvent.events,
    groups,
    actors,
    [],
    new Map(),
    [],
    [],
    [],
    ''
  );
}
describe('group and resolution generation contracts', () => {
  afterEach(() => mock.restore());
  test('maps reversed XML groups by supplied ID and renders genesis without scenario or question', async () => {
    spyOn(Math, 'random').mockReturnValue(0);
    const { instance, calls } = makeGenerator(xmlEvents());
    const output = await groupBatch(instance);
    expect(output['alpha-id']?.[0]).toMatchObject({
      from: 'alice',
      message: 'First message',
      clueStrength: 0.7,
    });
    expect(output['beta-id']?.[0]).toMatchObject({
      from: 'bob',
      message: 'Second message',
      clueStrength: 0.4,
    });
    expect(calls[0]).toContain('groupId: alpha-id');
    expect(calls[0]).toContain('actorId: alice');
    expect(calls[0]).toContain('No active scenarios.');
    expect(calls[0]).toContain('No active questions.');
  });
  test.each([
    ['hallucinated group', 'invented', 'alice'],
    ['hallucinated member', 'alpha-id', 'intruder'],
    ['duplicate group', 'beta-id', 'alice'],
  ])(
    'rejects %s',
    async (_name, groupId, actorId) => {
      spyOn(Math, 'random').mockReturnValue(0);
      const { instance } = makeGenerator(xmlEvents(groupId, actorId));
      await expect(groupBatch(instance)).rejects.toThrow(
        /failed to generate group messages/i
      );
    },
    10000
  );
  test('resolution uses question number for history, result, and final evidence', async () => {
    const parsed = parseXML(
      '<response><event>The launch succeeds.</event><type>announcement</type></response>'
    );
    expect(parsed.success).toBe(true);
    const { instance, calls } = makeGenerator(parsed.data);
    const result = await instance.generateResolutionEvent(
      question,
      actors,
      28,
      [dayWithEvent]
    );
    expect(calls[0]).toContain('Earlier launch evidence.');
    expect(result).toMatchObject({
      description: 'The launch succeeds.',
      relatedQuestion: 77,
      type: 'announcement',
    });
    expect(
      instance.generateResolution([question], [dayWithEvent]).outcomes[0]
    ).toMatchObject({
      questionId: 'db-77',
      keyEvents: ['Earlier launch evidence.'],
    });
  });
  test.each([
    {},
    { event: '', type: 'announcement' },
    { event: 'An event', type: 'disclosure' },
  ])('rejects invalid resolution response %o', async (response) => {
    const { instance } = makeGenerator(response);
    await expect(
      instance.generateResolutionEvent(question, actors, 28, [])
    ).rejects.toThrow(/invalid resolution event/i);
  });
  test('schedules one resolution for each question on days 28, 29 and 30', async () => {
    const { instance } = makeGenerator({});
    instance.generateDayEventsBatch = async () => [];
    instance.feedGenerator = {
      setActorStates: () => {},
      setRelationships: () => {},
      setActorGroupContexts: () => {},
      generateDayFeed: async () => [],
    };
    const resolved: Array<string | number> = [];
    instance.generateResolutionEvent = async (q, _actors, day) => {
      resolved.push(q.id);
      return {
        id: `resolution-${day}`,
        day,
        type: 'announcement',
        actors: [],
        description: q.text,
        relatedQuestion: q.questionNumber,
        pointsToward: 'YES',
        visibility: 'public',
      };
    };
    const questions = [
      question,
      { ...question, id: 'db-78', questionNumber: 78 },
      { ...question, id: 'db-79', questionNumber: 79 },
    ];
    for (const day of [28, 29, 30]) {
      const result = await instance.generateDay(
        day,
        { mains: [], supporting: [], extras: [] },
        questions,
        [],
        [],
        [],
        new Map(),
        '2026-11-01',
        []
      );
      expect(result.events).toHaveLength(1);
    }
    expect(resolved).toEqual(['db-77', 'db-78', 'db-79']);
  });
});
