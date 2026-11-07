import { describe, expect, test } from 'bun:test';
import {
  createQuestionPrompt,
  createScenarioPrompt,
  GameGenerator,
} from '@feed/engine';
import type {
  Organization,
  Question,
  Scenario,
  SelectedActor,
} from '@feed/shared';

type TestableGameGenerator = {
  llm: {
    generateJSON: () => Promise<unknown>;
  };
  generateScenarios: (
    mains: SelectedActor[],
    organizations: Organization[]
  ) => Promise<Scenario[]>;
  generateQuestions: (
    scenarios: Scenario[],
    organizations: Organization[]
  ) => Promise<Question[]>;
};

function asTestableGameGenerator(
  generator: GameGenerator
): TestableGameGenerator {
  return generator as unknown as TestableGameGenerator;
}

function buildGeneratorWithQuestionsResponse(
  response: unknown
): TestableGameGenerator {
  const generator = asTestableGameGenerator(new GameGenerator('test-key'));
  generator.llm = {
    generateJSON: async () => response,
  };

  return generator;
}

function buildScenarios(): Scenario[] {
  return [
    {
      id: 1,
      title: 'Scenario One',
      description: 'The first scenario',
      mainActors: ['actor-1'],
      involvedOrganizations: ['org-1'],
      theme: 'market structure',
    },
    {
      id: 2,
      title: 'Scenario Two',
      description: 'The second scenario',
      mainActors: ['actor-2'],
      involvedOrganizations: ['org-2'],
      theme: 'narrative shift',
    },
  ];
}

function buildOrganizations(): Organization[] {
  return [
    {
      id: 'org-1',
      name: 'Org One',
      description: 'The first organization',
      type: 'company',
      canBeInvolved: true,
    },
    {
      id: 'org-2',
      name: 'Org Two',
      description: 'The second organization',
      type: 'media',
      canBeInvolved: true,
    },
  ];
}

describe('GameGenerator question normalization', () => {
  test('prompts only the actual available scenario IDs', async () => {
    const prompt = await createQuestionPrompt(
      buildScenarios(),
      buildOrganizations()
    );
    expect(prompt).toContain('Allowed scenario IDs: 1, 2');
    expect(prompt).toContain('Do not invent or renumber scenario IDs');
  });

  test('derives scenario ids from grouped question responses', async () => {
    const generator = buildGeneratorWithQuestionsResponse([
      {
        questions: [
          {
            text: 'Will scenario one resolve positively?',
            questionNumber: '1',
          },
        ],
      },
      {
        questions: [
          {
            text: 'Will scenario two resolve positively?',
            questionNumber: 2,
          },
        ],
      },
    ]);

    const questions = await generator.generateQuestions(
      buildScenarios(),
      buildOrganizations()
    );

    expect(questions).toHaveLength(2);
    expect(questions[0]?.scenario).toBe(1);
    expect(questions[0]?.scenarioId).toBe(1);
    expect(questions[0]?.questionNumber).toBe(1);
    expect(questions[1]?.scenario).toBe(2);
    expect(questions[1]?.scenarioId).toBe(2);
    expect(questions[1]?.questionNumber).toBe(2);
  });

  test('rejects questions that do not identify a scenario', async () => {
    const generator = buildGeneratorWithQuestionsResponse({
      questions: [
        {
          text: 'This question omitted a scenario reference',
          questionNumber: 1,
        },
      ],
    });

    await expect(
      generator.generateQuestions(buildScenarios(), buildOrganizations())
    ).rejects.toThrow(/without scenario/);
  });

  test('rejects questions that reference scenarios outside the generated set', async () => {
    const generator = buildGeneratorWithQuestionsResponse({
      questions: [
        {
          text: 'This question points at a missing scenario',
          scenario: 3,
          questionNumber: 1,
        },
      ],
    });

    await expect(
      generator.generateQuestions(buildScenarios(), buildOrganizations())
    ).rejects.toThrow(/outside range 1-2/);
  });
});

describe('GameGenerator scenario contract', () => {
  const scenario = buildScenarios()[0]!;
  const mains: SelectedActor[] = [1, 2, 3].map((id) => ({
    id: `actor-${id}`,
    name: `Actor ${id}`,
    tier: 'S_TIER',
    role: 'main',
    initialLuck: 'medium',
    initialMood: 0,
  }));

  for (const count of [1, 2, 4]) {
    test(`rejects ${count} scenarios instead of the required three`, async () => {
      const generator = buildGeneratorWithQuestionsResponse({
        scenarios: {
          scenario: Array.from({ length: count }, (_, index) => ({
            ...scenario,
            id: index + 1,
          })),
        },
      });
      await expect(
        generator.generateScenarios(mains, buildOrganizations())
      ).rejects.toThrow('exactly 3 scenarios');
    });
  }

  for (const ids of [
    [1, 1, 3],
    [1, 2, 4],
    [1, 2, 0],
    [1, 2, 1.5],
    [1, 2, undefined],
  ]) {
    test(`rejects invalid scenario IDs ${JSON.stringify(ids)}`, async () => {
      const generator = buildGeneratorWithQuestionsResponse({
        scenarios: { scenario: ids.map((id) => ({ ...scenario, id })) },
      });
      await expect(
        generator.generateScenarios(mains, buildOrganizations())
      ).rejects.toThrow('unique IDs 1, 2, and 3');
    });
  }

  test('normalizes XML numeric IDs without replacing or dropping scenarios', async () => {
    const generator = buildGeneratorWithQuestionsResponse({
      scenarios: {
        scenario: ['3', '1', '2'].map((id) => ({
          ...scenario,
          id,
          mainActors: { actorId: ['actor-1', 'actor-2'] },
        })),
      },
    });
    const scenarios = await generator.generateScenarios(
      mains,
      buildOrganizations()
    );
    expect(scenarios.map((item) => item.id)).toEqual([1, 2, 3]);
    expect(scenarios[0]?.mainActors).toEqual(['actor-1', 'actor-2']);
  });

  test('renders three scenario nodes and exact actor and organization IDs', async () => {
    const prompt = await createScenarioPrompt(
      [
        {
          id: 'actor-1',
          name: 'Actor One',
          description: 'A main actor',
          domain: ['tech'],
        },
      ],
      buildOrganizations()
    );
    const format = prompt.split('Return XML:')[1];
    expect(format?.match(/<scenario>/g)).toHaveLength(3);
    for (const id of [1, 2, 3]) expect(format).toContain(`<id>${id}</id>`);
    expect(prompt).toContain('Actor One (ID: actor-1)');
    expect(prompt).toContain('Org One (ID: org-1)');
    expect(prompt).toContain('Org Two (ID: org-2)');
    expect(prompt).toContain('actorId and orgId must use the exact listed IDs');
  });
});
