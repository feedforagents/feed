import { describe, expect, test } from 'bun:test';
import { GameGenerator, parseXML } from '@feed/engine';
import type { Question } from '@feed/shared';

type RankingCall = {
  prompt: string;
  schema: { required?: string[] } | undefined;
  options: { temperature?: number; maxTokens?: number; promptType?: string };
};

type TestableGenerator = {
  llm: {
    generateJSON: (
      prompt: string,
      schema: RankingCall['schema'],
      options: RankingCall['options']
    ) => Promise<unknown>;
  };
  rankAndSelectQuestions: (questions: Question[]) => Promise<Question[]>;
};

function createGenerator(response: unknown, calls: RankingCall[] = []) {
  const generator = new GameGenerator(
    'test-key'
  ) as unknown as TestableGenerator;
  generator.llm = {
    generateJSON: async (prompt, schema, options) => {
      calls.push({ prompt, schema, options });
      return response;
    },
  };
  return generator;
}

function question(id: string, rank: number): Question {
  return { id, text: `Question ${id}?`, scenario: 1, outcome: true, rank };
}

describe('game question rankings', () => {
  test('applies positions to non-positional string IDs and preserves IDs', async () => {
    const calls: RankingCall[] = [];
    const parsed = parseXML(`<response><rankings>
      <ranking><questionId>1</questionId><rank>3</rank></ranking>
      <ranking><questionId>2</questionId><rank>2</rank></ranking>
      <ranking><questionId>3</questionId><rank>1</rank></ranking>
    </rankings></response>`);
    expect(parsed.success).toBe(true);
    const generator = createGenerator(parsed.data, calls);
    const result = await generator.rankAndSelectQuestions([
      question('101', 1),
      question('900', 2),
      question('42', 3),
    ]);

    expect(result.map(({ id, rank }) => [id, rank])).toEqual([
      ['42', 1],
      ['900', 2],
      ['101', 3],
    ]);
    expect(calls[0]?.schema?.required).toEqual(['rankings']);
    expect(calls[0]?.options).toMatchObject({
      temperature: 0.5,
      maxTokens: 4000,
      promptType: 'rank_questions',
    });
    expect(calls[0]?.prompt).not.toContain('<narrativeConnection>');
    expect(calls[0]?.prompt).not.toContain('<reasoning>');
  });

  test('accepts a singleton XML element inside a response wrapper', async () => {
    const generator = createGenerator({
      response: { rankings: { ranking: { questionId: '1', rank: '1' } } },
    });
    const result = await generator.rankAndSelectQuestions([
      question('external-id', 9),
    ]);
    expect(result.map(({ id, rank }) => [id, rank])).toEqual([
      ['external-id', 1],
    ]);
  });

  const invalid = [
    [
      'duplicate question position',
      [
        { questionId: 1, rank: 1 },
        { questionId: 1, rank: 2 },
      ],
    ],
    [
      'duplicate rank',
      [
        { questionId: 1, rank: 1 },
        { questionId: 2, rank: 1 },
      ],
    ],
    ['missing entry', [{ questionId: 1, rank: 1 }]],
    [
      'out-of-range position',
      [
        { questionId: 1, rank: 1 },
        { questionId: 3, rank: 2 },
      ],
    ],
    [
      'out-of-range rank',
      [
        { questionId: 1, rank: 1 },
        { questionId: 2, rank: 3 },
      ],
    ],
    [
      'non-integer position',
      [
        { questionId: '1.5', rank: 1 },
        { questionId: 2, rank: 2 },
      ],
    ],
    [
      'non-integer rank',
      [
        { questionId: 1, rank: 1 },
        { questionId: 2, rank: 1.5 },
      ],
    ],
    ['missing rankings', null],
  ] as const;

  for (const [label, ranking] of invalid) {
    test(`rejects ${label} without modifying questions`, async () => {
      const generator = createGenerator(
        ranking === null ? {} : { rankings: { ranking } }
      );
      const questions = [question('first', 1), question('second', 2)];
      await expect(generator.rankAndSelectQuestions(questions)).rejects.toThrow(
        /invalid.*ranking/i
      );
      expect(questions.map(({ id, rank }) => [id, rank])).toEqual([
        ['first', 1],
        ['second', 2],
      ]);
    });
  }
});
