import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { CRYPTO_PARODY_NAMES } from '../data/reality-grounding';
import { StaticDataRegistry } from '../services/static-data-registry';

const rssRows: Array<{
  id: string;
  title: string;
  summary?: string | null;
  publishedAt: Date;
}> = [];

const parodyRows: Array<{
  originalHeadlineId: string;
  originalTitle: string;
  parodyTitle: string;
  generatedAt: Date;
}> = [];

const storedTopics: Array<Record<string, unknown>> = [];

const dbMock = {
  dailyTopic: {
    findFirst: mock(async (args?: Record<string, unknown>) => {
      const where = args?.where as
        | { date?: { equals?: Date; lt?: Date } }
        | undefined;
      if (where?.date?.equals) {
        return (
          storedTopics.find(
            (topic) =>
              (topic.date as Date).getTime() === where.date?.equals?.getTime()
          ) ?? null
        );
      }
      if (where?.date?.lt) {
        return (
          [...storedTopics]
            .filter((topic) => (topic.date as Date) < where.date!.lt!)
            .sort(
              (a, b) => (b.date as Date).getTime() - (a.date as Date).getTime()
            )[0] ?? null
        );
      }
      return null;
    }),
  },
  select: mock(() => ({
    from: mock((table: { __name: string }) => ({
      where: mock(() => ({
        orderBy: mock(() => ({
          limit: mock(() =>
            Promise.resolve(
              table.__name === 'rssHeadlines' ? [...rssRows] : [...parodyRows]
            )
          ),
        })),
      })),
    })),
  })),
  selectDistinct: mock(() => ({
    from: mock((_table: { __name: string }) => ({
      where: mock(() =>
        Promise.resolve(
          storedTopics.map((t) => ({ topicKey: t.topicKey as string }))
        )
      ),
    })),
  })),
  insert: mock(() => ({
    values: mock((data: Record<string, unknown>) => ({
      onConflictDoUpdate: mock(
        ({
          set,
          setWhere,
        }: {
          set: Record<string, unknown>;
          setWhere?: unknown;
        }) => ({
          returning: mock(async () => {
            const existingIndex = storedTopics.findIndex(
              (topic) =>
                (topic.date as Date).getTime() === (data.date as Date).getTime()
            );

            // setWhere is only used as "existing row is not locked"
            if (
              existingIndex >= 0 &&
              setWhere !== undefined &&
              storedTopics[existingIndex]?.isLocked === true
            ) {
              return [];
            }

            if (existingIndex >= 0) {
              storedTopics[existingIndex] = {
                ...storedTopics[existingIndex],
                ...set,
              };
              return [storedTopics[existingIndex]];
            }

            storedTopics.push(data);
            return [data];
          }),
        })
      ),
    })),
  })),
  delete: mock(() => ({
    where: mock(async () => []),
  })),
};

mock.module('@feed/db', () => ({
  db: dbMock,
  dailyTopics: { __name: 'dailyTopics', id: 'id', isLocked: 'isLocked' },
  rssHeadlines: {
    __name: 'rssHeadlines',
    publishedAt: 'publishedAt',
    id: 'id',
  },
  parodyHeadlines: {
    __name: 'parodyHeadlines',
    generatedAt: 'generatedAt',
    originalHeadlineId: 'originalHeadlineId',
  },
  and: (...args: unknown[]) => args,
  desc: (value: unknown) => value,
  generateSnowflakeId: mock(async () => `topic-${storedTopics.length + 1}`),
  eq: (a: unknown, b: unknown) => [a, b],
  gte: (a: unknown, b: unknown) => [a, b],
  lt: (a: unknown, b: unknown) => [a, b],
}));

const { escapeRegex } = await import('@feed/shared');
mock.module('@feed/shared', () => ({
  escapeRegex,
  logger: {
    info: mock(() => {}),
    warn: mock(() => {}),
  },
}));

import {
  buildDailyTopicPromptContext,
  buildMultiTopicPromptContext,
  type DailyTopicContext,
  dailyTopicService,
  deriveTopicFromText,
  isTextOnAnyTopic,
  isTextOnTopic,
  normalizeTopicDate,
} from '../services/daily-topic-service';

describe('daily-topic-service', () => {
  beforeEach(() => {
    rssRows.length = 0;
    parodyRows.length = 0;
    storedTopics.length = 0;
    dbMock.dailyTopic.findFirst.mockClear?.();
  });

  test('listCandidates ranks repeated headline topics highest', async () => {
    rssRows.push(
      {
        id: 'h1',
        title: 'OpenAI unveils new reasoning model',
        summary: 'OpenAI expands enterprise rollout',
        publishedAt: new Date('2026-03-06T08:00:00.000Z'),
      },
      {
        id: 'h2',
        title: 'OpenAI faces scrutiny over new launch',
        summary: 'Developers react to OpenAI roadmap',
        publishedAt: new Date('2026-03-06T09:00:00.000Z'),
      },
      {
        id: 'h3',
        title: 'Tesla changes pricing again',
        summary: 'Another Tesla pricing move',
        publishedAt: new Date('2026-03-06T09:30:00.000Z'),
      }
    );

    const candidates = await dailyTopicService.listCandidates(
      new Date('2026-03-06T12:00:00.000Z')
    );

    expect(candidates[0]?.topicKey).toBe('openai');
    expect(candidates[0]?.sourceHeadlineIds).toContain('h1');
    expect(candidates[0]?.sourceHeadlineIds).toContain('h2');
  });

  test('ensureTopicForDate falls back to previous topic when no candidates exist', async () => {
    storedTopics.push({
      id: 'prev-topic',
      date: new Date('2026-03-05T00:00:00.000Z'),
      topicKey: 'openai',
      topicLabel: 'OpenAI',
      summary: 'OpenAI dominates the day',
      sourceType: 'auto',
      sourceHeadlineIds: ['h1'],
      selectionReason: 'Matched headlines',
      isLocked: false,
      createdAt: new Date('2026-03-05T00:00:00.000Z'),
      updatedAt: new Date('2026-03-05T00:00:00.000Z'),
    });

    const topic = await dailyTopicService.ensureTopicForDate(
      new Date('2026-03-06T14:00:00.000Z')
    );

    expect(topic?.topicKey).toBe('openai');
    expect(topic?.sourceType).toBe('fallback_previous_day');
  });

  test('ensureTopicForDate falls back to default topic when no candidates exist yet', async () => {
    const topic = await dailyTopicService.ensureTopicForDate(
      new Date('2026-03-06T14:00:00.000Z')
    );

    expect(topic?.topicKey).toBe('general');
    expect(topic?.topicLabel).toBe('General');
    expect(topic?.sourceType).toBe('fallback_default');
  });

  test('helper functions derive prompt-safe topic context', () => {
    const topic = deriveTopicFromText(
      'OpenAI leadership drama continues through launch day',
      new Date('2026-03-06T14:00:00.000Z')
    );

    expect(
      normalizeTopicDate(new Date('2026-03-06T14:00:00.000Z')).toISOString()
    ).toBe('2026-03-06T00:00:00.000Z');
    expect(buildDailyTopicPromptContext(topic)).toContain(topic.topicLabel);
    expect(
      isTextOnTopic('Will OpenAI announce another feature today?', topic)
    ).toBe(true);
    expect(isTextOnTopic('Will Tesla stock jump today?', topic)).toBe(false);
  });

  describe('topic filtering', () => {
    const date = new Date('2026-03-06T00:00:00.000Z');
    const general: DailyTopicContext = {
      date,
      topicKey: 'general',
      topicLabel: 'General',
      summary: 'General market-moving developments across the Feed world',
      sourceType: 'fallback_default',
      sourceHeadlineIds: [],
      selectionReason: null,
      isLocked: false,
    };

    test('the automatic General fallback accepts specific world developments', () => {
      expect(isTextOnTopic('Will TeslAI release its earnings?', general)).toBe(
        true
      );
    });

    test('previous-day, manual, and locked topics retain their topic constraints', () => {
      const specificTopics: DailyTopicContext[] = [
        {
          ...general,
          sourceType: 'fallback_previous_day',
          summary: 'Election deadlines',
        },
        {
          ...general,
          sourceType: 'manual_override',
          summary: 'Election deadlines',
        },
        { ...general, isLocked: true, summary: 'Election deadlines' },
        { ...general, topicKey: 'election', summary: 'Election deadlines' },
      ];
      for (const topic of specificTopics) {
        expect(isTextOnTopic('Will TeslAI release its earnings?', topic)).toBe(
          false
        );
        expect(
          isTextOnTopic('Will election results be published?', topic)
        ).toBe(true);
      }
    });

    for (const [realName, parodyName] of Object.entries(CRYPTO_PARODY_NAMES)) {
      test(`locked ${realName} topics match the canonical crypto name without accepting unrelated text`, () => {
        const topic: DailyTopicContext = {
          ...general,
          topicKey: realName.toLowerCase(),
          topicLabel: realName,
          summary: realName,
          sourceType: 'manual_override',
          isLocked: true,
        };
        expect(
          isTextOnTopic(`Will ${parodyName} reach its target today?`, topic)
        ).toBe(true);
        expect(
          isTextOnTopic(`Will ${realName} reach its target today?`, topic)
        ).toBe(true);
        expect(isTextOnTopic('Will OpenAGI release a new model?', topic)).toBe(
          false
        );
      });
    }

    for (const realName of ['OpenAI', 'Tesla', 'Bill Gates']) {
      test(`matches ${realName} and its registered parody without accepting unrelated text`, () => {
        const parodyName =
          StaticDataRegistry.getParodyName(realName) ??
          StaticDataRegistry.getParodyOrgName(realName);
        expect(parodyName).not.toBeNull();
        const realTopic = deriveTopicFromText(realName, date);
        const parodyTopic = deriveTopicFromText(parodyName!, date);
        expect(
          isTextOnTopic(`Will ${parodyName} publish a statement?`, realTopic)
        ).toBe(true);
        expect(
          isTextOnTopic(`Will ${realName} publish a statement?`, parodyTopic)
        ).toBe(true);
        expect(
          isTextOnTopic('Will Blue OrigAIn launch a rocket?', realTopic)
        ).toBe(false);
      });
    }
  });

  describe('deriveTopicFromText frequency-based selection', () => {
    const date = new Date('2026-03-06T14:00:00.000Z');

    test('picks the most frequent token over earlier tokens', () => {
      const topic = deriveTopicFromText(
        'Tesla announced Tesla earnings while Apple waits',
        date
      );
      expect(topic.topicKey).toBe('tesla');
    });

    test('breaks ties by longest token (more specific)', () => {
      const topic = deriveTopicFromText(
        'Apple versus Microsoft in cloud battle',
        date
      );
      // "microsoft" (9 chars) > "apple" (5 chars) > "cloud" (5 chars) > "battle" (6 chars)
      expect(topic.topicKey).toBe('microsoft');
    });

    test('returns "general" when all tokens are stopwords', () => {
      const topic = deriveTopicFromText(
        'does the stock market move above this level next week',
        date
      );
      expect(topic.topicKey).toBe('general');
      expect(topic.topicLabel).toBe('General');
    });

    test('filters out known nonsense stopwords (burp, dill, cumin)', () => {
      const topic = deriveTopicFromText(
        'burp dill cumin powered tech from OpenAI OpenAI',
        date
      );
      // "burp" (4 chars) and "dill" (4 chars) and "cumin" (5 chars) and "powered" and "tech" are all stopwords.
      // "openai" appears twice, wins by frequency
      expect(topic.topicKey).toBe('openai');
    });

    test('handles empty text gracefully', () => {
      const topic = deriveTopicFromText('', date);
      expect(topic.topicKey).toBe('general');
      expect(topic.topicLabel).toBe('General');
    });

    test('normalizes topic date to midnight UTC', () => {
      const topic = deriveTopicFromText('Tesla news', date);
      expect(topic.date.toISOString()).toBe('2026-03-06T00:00:00.000Z');
    });
  });

  describe('isTextOnAnyTopic', () => {
    const date = new Date('2026-03-06T00:00:00.000Z');
    const openaiTopic = deriveTopicFromText('OpenAI launches new model', date);
    const teslaTopic = deriveTopicFromText('Tesla earnings report', date);
    const appleTopic = deriveTopicFromText('Apple launches new iPhone', date);

    test('returns true when text matches any topic', () => {
      expect(
        isTextOnAnyTopic('Tesla stock surges on earnings beat', [
          openaiTopic,
          teslaTopic,
          appleTopic,
        ])
      ).toBe(true);
    });

    test('returns false when text matches no topics', () => {
      expect(
        isTextOnAnyTopic('Bitcoin mining operations expand globally', [
          openaiTopic,
          teslaTopic,
          appleTopic,
        ])
      ).toBe(false);
    });

    test('returns true for empty topics array (permissive fallback)', () => {
      expect(isTextOnAnyTopic('Anything goes here', [])).toBe(true);
    });

    test('returns true when text matches the only topic', () => {
      expect(
        isTextOnAnyTopic('OpenAI announces partnership', [openaiTopic])
      ).toBe(true);
    });
  });

  describe('buildMultiTopicPromptContext', () => {
    const date = new Date('2026-03-06T00:00:00.000Z');
    const openaiTopic = deriveTopicFromText('OpenAI launches new model', date);
    const teslaTopic = deriveTopicFromText('Tesla earnings report', date);

    test('returns permissive prompt for empty topics', () => {
      const result = buildMultiTopicPromptContext([]);
      expect(result).toContain('No daily topics');
      expect(result).toContain('any trending topic');
    });

    test('delegates to single-topic builder for one topic', () => {
      const multi = buildMultiTopicPromptContext([openaiTopic]);
      const single = buildDailyTopicPromptContext(openaiTopic);
      expect(multi).toBe(single);
    });

    test('lists multiple topics with diversity instructions', () => {
      const result = buildMultiTopicPromptContext([openaiTopic, teslaTopic]);
      expect(result).toContain('active topics');
      expect(result).toContain(openaiTopic.topicLabel);
      expect(result).toContain(teslaTopic.topicLabel);
      expect(result).toContain('variety');
    });
  });

  describe('getTopicCandidatesForDate', () => {
    test('returns primary topic plus additional candidates', async () => {
      rssRows.push(
        {
          id: 'h1',
          title: 'OpenAI unveils new reasoning model',
          summary: 'OpenAI expands enterprise rollout',
          publishedAt: new Date('2026-03-06T08:00:00.000Z'),
        },
        {
          id: 'h2',
          title: 'OpenAI faces scrutiny over new launch',
          summary: 'Developers react to OpenAI roadmap',
          publishedAt: new Date('2026-03-06T09:00:00.000Z'),
        },
        {
          id: 'h3',
          title: 'Tesla changes pricing again',
          summary: 'Another Tesla pricing move',
          publishedAt: new Date('2026-03-06T09:30:00.000Z'),
        },
        {
          id: 'h4',
          title: 'Apple launches new product line',
          summary: 'Apple reveals next generation devices',
          publishedAt: new Date('2026-03-06T10:00:00.000Z'),
        }
      );

      const candidates = await dailyTopicService.getTopicCandidatesForDate(
        new Date('2026-03-06T12:00:00.000Z'),
        3
      );

      expect(candidates.length).toBeGreaterThanOrEqual(1);
      expect(candidates.length).toBeLessThanOrEqual(3);
      // Primary topic should be first
      expect(candidates[0]?.topicKey).toBeDefined();
    });

    test('returns only primary when no additional candidates', async () => {
      // Single headline — only one candidate possible
      rssRows.push({
        id: 'h1',
        title: 'OpenAI unveils new reasoning model',
        summary: 'OpenAI expands enterprise rollout',
        publishedAt: new Date('2026-03-06T08:00:00.000Z'),
      });

      const candidates = await dailyTopicService.getTopicCandidatesForDate(
        new Date('2026-03-06T12:00:00.000Z'),
        3
      );

      expect(candidates.length).toBeGreaterThanOrEqual(1);
      expect(candidates[0]?.topicKey).toBeDefined();
    });

    test('returns only the default fallback topic when no headlines exist', async () => {
      const candidates = await dailyTopicService.getTopicCandidatesForDate(
        new Date('2026-03-06T12:00:00.000Z')
      );

      // With no RSS rows and no stored topics, ensureTopicForDate persists the
      // "general" default and there are no additional candidates.
      expect(candidates.map((c) => c.topicKey)).toEqual(['general']);
    });

    test('excludes primary from additional candidates', async () => {
      rssRows.push(
        {
          id: 'h1',
          title: 'OpenAI unveils new reasoning model',
          summary: 'OpenAI expands enterprise rollout',
          publishedAt: new Date('2026-03-06T08:00:00.000Z'),
        },
        {
          id: 'h2',
          title: 'OpenAI faces scrutiny over launch',
          summary: 'Developers react to OpenAI roadmap',
          publishedAt: new Date('2026-03-06T09:00:00.000Z'),
        },
        {
          id: 'h3',
          title: 'Tesla changes pricing strategy',
          summary: 'Tesla pricing move surprises market',
          publishedAt: new Date('2026-03-06T09:30:00.000Z'),
        }
      );

      const candidates = await dailyTopicService.getTopicCandidatesForDate(
        new Date('2026-03-06T12:00:00.000Z'),
        3
      );

      // Primary topic should not appear twice
      const topicKeys = candidates.map((c) => c.topicKey);
      const uniqueKeys = new Set(topicKeys);
      expect(uniqueKeys.size).toBe(topicKeys.length);
    });
  });

  describe('manual lock protection', () => {
    const lockedTopic = () => ({
      id: 'locked-topic',
      date: new Date('2026-03-06T00:00:00.000Z'),
      topicKey: 'manual',
      topicLabel: 'Manual',
      summary: 'Admin chosen topic',
      sourceType: 'manual_override',
      sourceHeadlineIds: [],
      selectionReason: 'Manually overridden in admin',
      isLocked: true,
      createdAt: new Date('2026-03-06T00:00:00.000Z'),
      updatedAt: new Date('2026-03-06T00:00:00.000Z'),
    });

    test('automatic selection racing a manual lock keeps the locked topic', async () => {
      rssRows.push({
        id: 'h1',
        title: 'OpenAI unveils new reasoning model',
        summary: 'OpenAI expands enterprise rollout',
        publishedAt: new Date('2026-03-06T08:00:00.000Z'),
      });
      // Simulate the lock landing after ensureTopicForDate read "no topic"
      dbMock.dailyTopic.findFirst.mockImplementationOnce(async () => null);
      storedTopics.push(lockedTopic());

      const topic = await dailyTopicService.ensureTopicForDate(
        new Date('2026-03-06T12:00:00.000Z')
      );

      expect(topic?.topicKey).toBe('manual');
      expect(topic?.isLocked).toBe(true);
      expect(storedTopics[0]?.topicKey).toBe('manual');
    });

    test('recompute replaces an unlocked topic in place without deleting it', async () => {
      storedTopics.push({ ...lockedTopic(), isLocked: false, id: 'auto-1' });
      rssRows.push({
        id: 'h1',
        title: 'OpenAI unveils new reasoning model',
        summary: 'OpenAI expands enterprise rollout',
        publishedAt: new Date('2026-03-06T08:00:00.000Z'),
      });
      dbMock.delete.mockClear();

      const topic = await dailyTopicService.recomputeTopicForDate(
        new Date('2026-03-06T12:00:00.000Z')
      );

      expect(dbMock.delete).not.toHaveBeenCalled();
      expect(storedTopics).toHaveLength(1);
      expect(storedTopics[0]?.id).toBe('auto-1');
      expect(topic?.topicKey).not.toBe('manual');
      expect(topic?.sourceType).toBe('auto');
    });

    test('clearOverride explicitly replaces a locked topic', async () => {
      storedTopics.push(lockedTopic());

      const topic = await dailyTopicService.clearOverride(
        new Date('2026-03-06T12:00:00.000Z')
      );

      expect(topic?.isLocked).toBe(false);
      expect(storedTopics).toHaveLength(1);
    });
  });

  test('rejects non-positive candidate counts and empty manual labels', async () => {
    await expect(
      dailyTopicService.getTopicCandidatesForDate(new Date(), 0)
    ).rejects.toThrow('positive integer');
    await expect(
      dailyTopicService.setManualTopic({ topicLabel: '   ' })
    ).rejects.toThrow('cannot be empty');
  });
});
