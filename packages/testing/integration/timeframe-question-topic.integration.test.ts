import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { db, eq, worldEvents } from '@feed/db';
import { FeedLLMClient, QuestionManager } from '@feed/engine';
import { generateSnowflakeId } from '@feed/shared';
import type { DailyTopicContext } from '../../engine/src/services/daily-topic-service';

// The model response is isolated; all prompt-context queries use the real DB.
const client = new FeedLLMClient('boundary-test-only', 'openai');
const completion = spyOn(client, 'generateJSON');
const manager = new QuestionManager(client);
const topic = (name: string): DailyTopicContext => ({
  date: new Date('2026-11-03T00:00:00Z'),
  topicKey: name.toLowerCase(),
  topicLabel: name,
  summary: name,
  sourceType: 'auto',
  sourceHeadlineIds: [],
  selectionReason: null,
  isLocked: false,
});
const openai = topic('OpenAI');
const tesla = topic('Tesla');
const general: DailyTopicContext = {
  ...topic('General'),
  sourceType: 'fallback_default',
  summary: 'General market-moving developments across the Feed world',
};
let eventId: string;
let eventDescription: string;

beforeAll(async () => {
  eventId = await generateSnowflakeId();
  eventDescription = `OpenAGI publishes release schedule ${eventId}.`;
  await db.insert(worldEvents).values({
    id: eventId,
    eventType: 'announcement',
    description: eventDescription,
    visibility: 'public',
    timestamp: new Date(),
  });
});
afterAll(async () => {
  completion.mockRestore();
  if (eventId) await db.delete(worldEvents).where(eq(worldEvents.id, eventId));
});

function generate(
  selected: DailyTopicContext,
  candidates: DailyTopicContext[] = [],
  overrides: Partial<{
    text: string;
    resolutionCriteria: string;
    expectedOutcome: string | boolean;
    primaryActor: string;
    primaryOrg: string;
  }> = {}
) {
  completion.mockResolvedValue({
    question: {
      text: 'Will OpenAGI release a model?',
      resolutionCriteria: 'Verify the release notes.',
      expectedOutcome: 'yes',
      ...overrides,
    },
  });
  return manager.generateTimeframeQuestion(
    '15m',
    900_000,
    selected,
    candidates
  );
}

describe('timeframe question topic boundary', () => {
  test('matches canonical aliases and includes persisted context', async () => {
    const result = await generate(openai);
    expect(result?.topic?.topicKey).toBe('openai');
    expect(completion.mock.calls.at(-1)?.[0]).toContain(eventDescription);
  });

  test('returns the matching candidate instead of the rotated primary', async () => {
    const result = await generate(openai, [openai, tesla], {
      text: 'Will TeslAI release earnings?',
    });
    expect(result?.topic?.topicKey).toBe('tesla');
  });

  test('prefers a specific matching candidate over the General fallback', async () => {
    const result = await generate(general, [general, openai]);
    expect(result?.topic?.topicKey).toBe('openai');
  });

  test('allows specific developments under the General fallback', async () => {
    const result = await generate(general, [], {
      text: 'Will TeslAI release earnings?',
    });
    expect(result?.topic?.topicKey).toBe('general');
  });

  test('preserves a parsed boolean false outcome', async () => {
    const result = await generate(openai, [], { expectedOutcome: false });
    expect(result?.expectedOutcome).toBe(false);
  });

  test('rejects open-ended wording instead of publishing a YES/NO market', async () => {
    for (const text of [
      'In how many days will OpenAGI publish its release schedule?',
      'When will OpenAGI publish its release schedule?',
      'Which OpenAGI model will release first?',
    ]) {
      expect(await generate(openai, [], { text })).toBeNull();
    }
    expect(
      await generate(openai, [], {
        text: 'Will OpenAGI publish a schedule explaining how many models it will release?',
      })
    ).not.toBeNull();
  });

  test('continuous generation rejects the observed open-ended response before writing', async () => {
    completion.mockResolvedValue({
      questions: {
        question: {
          text: 'In how many days will OpenAGI publish its release schedule?',
          resolutionCriteria: 'Verify the release schedule.',
          daysUntilResolution: 3,
          expectedOutcome: 'yes',
        },
      },
    });
    expect(
      await manager.generateQuestionsForContinuousGame(1, Date.now() + 30_000)
    ).toBe(0);
  });

  test('continuous generation skips malformed text and criteria before mapping', async () => {
    for (const fields of [
      { text: { value: 'Will OpenAGI release a model?' } },
      { text: '   ' },
      { resolutionCriteria: { value: 'Verify the release notes.' } },
      { resolutionCriteria: 42 },
      { resolutionCriteria: '   ' },
    ]) {
      completion.mockResolvedValue({
        questions: {
          question: {
            text: 'Will OpenAGI release a model?',
            resolutionCriteria: 'Verify the release notes.',
            daysUntilResolution: 3,
            expectedOutcome: 'yes',
            ...fields,
          },
        },
      });
      expect(
        await manager.generateQuestionsForContinuousGame(1, Date.now() + 30_000)
      ).toBe(0);
    }
  });

  test('rejects non-binary outcomes and missing resolution criteria', async () => {
    expect(await generate(openai, [], { expectedOutcome: 'maybe' })).toBeNull();
    expect(
      await generate(openai, [], { resolutionCriteria: undefined })
    ).toBeNull();
    expect(
      await generate(openai, [], { resolutionCriteria: '   ' })
    ).toBeNull();
  });

  test('affiliation metadata cannot make an unrelated question on-topic', async () => {
    const result = await generate(openai, [], {
      text: 'Will TeslAI release earnings?',
      primaryActor: 'OpenAGI',
      primaryOrg: 'OpenAGI',
    });
    expect(result).toBeNull();
  });
});
