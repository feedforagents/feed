import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { Actor, Organization, Question, WorldEvent } from '@feed/shared';
import { ArticleGenerator } from '../../engine/src/ArticleGenerator';
import { FeedLLMClient } from '../../engine/src/llm/openai-client';
import { QuestionManager } from '../../engine/src/QuestionManager';
import { ContentQualityGate } from '../../engine/src/services/content-quality-gate';
import { worldFactsService } from '../../engine/src/world-facts-service';

const question: Question = {
  id: 1,
  text: 'Will OpenAI publish its release schedule?',
  outcome: true,
  scenario: 1,
  rank: 1,
  status: 'active',
};
const organization: Organization = {
  id: 'the-daily-wire',
  name: 'The DAIly Wire',
  type: 'media',
  description: 'A news organization.',
  canBeInvolved: true,
};
const actors: Actor[] = [{ id: 'journalist', name: 'Reporter' }];
const publicFact =
  'OpenAI publicly confirmed the published release schedule at its quarterly briefing.';
const leakedFact = 'OpenAI release documents leaked with the confirmed dates.';
const privateFact = 'Secret internal acquisition plans are still confidential.';
const event = (
  id: string,
  description: string,
  visibility: WorldEvent['visibility']
): WorldEvent => ({
  id,
  description,
  visibility,
  day: 1,
  type: 'revelation',
  actors: [],
  relatedQuestion: 1,
});

describe('ArticleGenerator proof grounding context', () => {
  const client = new FeedLLMClient('contract-test-only', 'openai');
  const generator = new ArticleGenerator(client);
  let completion: ReturnType<typeof spyOn>;
  let quality: ReturnType<typeof spyOn>;

  afterEach(() => {
    completion.mockRestore();
    quality.mockRestore();
  });

  test('QuestionManager associates generated proof with a string-ID question number', async () => {
    completion = spyOn(client, 'generateJSON').mockResolvedValue({
      title: 'OpenAGI confirms the release schedule',
      summary: 'The published dates have been confirmed.',
      content:
        'OpenAGI publicly confirmed the published release schedule at its quarterly briefing. '.repeat(
          8
        ),
      slant: 'Neutral reporting',
      sentiment: 'neutral',
      category: 'tech',
      tags: [],
    });
    quality = spyOn(ContentQualityGate, 'validateArticle').mockResolvedValue({
      passed: true,
      score: 1,
      reasons: [],
    });
    const worldFacts = spyOn(
      worldFactsService,
      'generatePromptContext'
    ).mockResolvedValue('OpenAI published its release schedule.');
    try {
      const manager = new QuestionManager(client);
      await manager.generateProofContent(
        { ...question, id: 'db-77', questionNumber: 77 },
        publicFact,
        [
          {
            id: 'journalist',
            name: 'Reporter',
            tier: 'S_TIER',
            role: 'main',
            initialLuck: 'medium',
            initialMood: 0,
          },
        ],
        [organization]
      );
      expect(completion.mock.calls[0]?.[0]).toContain(publicFact);
      expect(completion.mock.calls[0]?.[0]).toContain('ONE JSON OBJECT');
      expect(completion.mock.calls[0]?.[2]).toMatchObject({ format: 'json' });
    } finally {
      worldFacts.mockRestore();
    }
  });

  for (const withNumber of [true, false]) {
    test(`string-ID proof context ${withNumber ? 'matches the question number' : 'ignores unlinked events'}`, async () => {
      completion = spyOn(client, 'generateJSON').mockResolvedValue({
        title: 'OpenAGI confirms the release schedule',
        summary: 'The published dates have been confirmed.',
        content:
          'OpenAGI publicly confirmed the published release schedule at its quarterly briefing. '.repeat(
            8
          ),
        slant: 'Neutral reporting',
        sentiment: 'neutral',
        category: 'tech',
        tags: [],
      });
      quality = spyOn(ContentQualityGate, 'validateArticle').mockResolvedValue({
        passed: true,
        score: 1,
        reasons: [],
      });
      const currentQuestion = {
        ...question,
        id: 'db-77',
        questionNumber: withNumber ? 77 : undefined,
      };
      const linkedEvent = {
        ...event('linked', publicFact, 'public'),
        relatedQuestion: 77,
      };
      const unrelatedEvent = {
        ...event('unrelated', 'Unrelated public launch evidence.', 'public'),
        relatedQuestion: null,
      };
      await generator.generateArticleForQuestion(
        currentQuestion,
        organization,
        'resolution',
        actors,
        [linkedEvent, unrelatedEvent],
        'OpenAI has published the release schedule for the current quarter.'
      );
      const prompt = completion.mock.calls[0]?.[0];
      if (withNumber) expect(prompt).toContain(publicFact);
      else expect(prompt).not.toContain(publicFact);
      expect(prompt).not.toContain('Unrelated public launch evidence.');
    });
  }

  test('retries one rejected resolution proof with focused feedback and lower temperature', async () => {
    completion = spyOn(client, 'generateJSON').mockResolvedValue({
      title: 'OpenAGI confirms the release schedule',
      summary: 'The published dates have been confirmed.',
      content:
        'OpenAGI publicly confirmed the published release schedule at its quarterly briefing. '.repeat(
          8
        ),
      slant: 'Neutral reporting',
      sentiment: 'neutral',
      category: 'tech',
      tags: [],
    });
    quality = spyOn(ContentQualityGate, 'validateArticle')
      .mockResolvedValueOnce({
        passed: false,
        score: 0,
        reasons: ['Unrelated article'],
      })
      .mockResolvedValueOnce({ passed: true, score: 1, reasons: [] });
    const article = await generator.generateArticleForQuestion(
      question,
      organization,
      'resolution',
      actors,
      [
        event('private', privateFact, 'private'),
        event('public', publicFact, 'public'),
      ],
      'OpenAI has published the release schedule for the current quarter.'
    );
    expect(article.content).toContain('OpenAGI publicly confirmed');
    expect(completion).toHaveBeenCalledTimes(2);
    expect(quality).toHaveBeenCalledTimes(2);
    expect(completion.mock.calls[0]?.[2]).toMatchObject({ temperature: 0.85 });
    expect(completion.mock.calls[1]?.[2]).toMatchObject({ temperature: 0.2 });
    expect(completion.mock.calls[1]?.[0]).toContain('previous article');
    expect(completion.mock.calls[1]?.[0]).toContain(publicFact);
    expect(completion.mock.calls[1]?.[0]).not.toContain(privateFact);
    expect(quality.mock.calls[1]?.[1]).toContain(
      publicFact.replace('OpenAI', 'OpenAGI')
    );
    expect(quality.mock.calls[1]?.[1]).not.toContain(privateFact);
  });

  for (const { stage, recovers } of [
    { stage: 'resolution', recovers: true },
    { stage: 'resolution', recovers: false },
    { stage: 'breaking', recovers: false },
  ] as const) {
    test(`${stage} short article ${recovers ? 'recovers within the existing retry' : 'remains rejected'}`, async () => {
      const response = {
        title: 'OpenAGI confirms the release schedule',
        summary: 'The published dates have been confirmed.',
        content: 'Too short for a proof article.',
        slant: 'Neutral reporting',
        sentiment: 'neutral',
        category: 'tech',
        tags: [],
      };
      completion = spyOn(client, 'generateJSON')
        .mockResolvedValueOnce(response)
        .mockResolvedValue({
          ...response,
          content: recovers ? publicFact.repeat(8) : response.content,
        });
      quality = spyOn(ContentQualityGate, 'validateArticle').mockResolvedValue({
        passed: true,
        score: 1,
        reasons: [],
      });
      const result = generator.generateArticleForQuestion(
        question,
        organization,
        stage,
        actors,
        [event('public', publicFact, 'public')],
        publicFact
      );
      if (stage === 'resolution' && recovers) {
        expect((await result).content.length).toBeGreaterThanOrEqual(500);
        expect(quality).toHaveBeenCalledTimes(1);
      } else {
        await expect(result).rejects.toThrow(
          stage === 'resolution'
            ? 'Article validation failed'
            : 'content too short'
        );
        expect(quality).not.toHaveBeenCalled();
      }
      expect(completion).toHaveBeenCalledTimes(stage === 'resolution' ? 2 : 1);
    });
  }

  test('does not retry transport errors', async () => {
    completion = spyOn(client, 'generateJSON').mockRejectedValue(
      new Error('provider unavailable')
    );
    quality = spyOn(ContentQualityGate, 'validateArticle');
    await expect(
      generator.generateArticleForQuestion(
        question,
        organization,
        'resolution',
        actors,
        [],
        'OpenAI release schedule context.'
      )
    ).rejects.toThrow('provider unavailable');
    expect(completion).toHaveBeenCalledTimes(1);
    expect(quality).not.toHaveBeenCalled();
  });

  for (const { stage, passed, outcome } of [
    { stage: 'resolution', passed: true, outcome: true },
    { stage: 'resolution', passed: true, outcome: false },
    { stage: 'resolution', passed: false, outcome: true },
    { stage: 'breaking', passed: true, outcome: true },
    { stage: 'breaking', passed: false, outcome: true },
  ] as const) {
    test(`${stage} uses public evidence: outcome=${outcome}, quality=${passed}`, async () => {
      // Inspect the real prompt and gate boundary; this is not inference evidence.
      completion = spyOn(client, 'generateJSON').mockResolvedValue({
        title: 'OpenAGI confirms the published release schedule',
        summary: 'OpenAGI has publicly confirmed the published dates.',
        content:
          'OpenAGI publicly confirmed the published release schedule at its quarterly briefing. '.repeat(
            8
          ),
        slant: 'Neutral reporting',
        sentiment: 'neutral',
        category: 'tech',
        tags: [],
      });
      quality = spyOn(ContentQualityGate, 'validateArticle').mockResolvedValue({
        passed,
        score: passed ? 1 : 0,
        reasons: passed ? [] : ['Unrelated article'],
      });

      const currentQuestion = {
        ...question,
        text: outcome
          ? question.text
          : 'Will OpenAI cancel its published release schedule?',
        outcome,
      };
      const result = generator.generateArticleForQuestion(
        currentQuestion,
        organization,
        stage,
        actors,
        [
          event('private', privateFact, 'private'),
          event('secret', 'Unleaked negotiation details.', 'secret'),
          event('public', publicFact, 'public'),
          event('leaked', leakedFact, 'leaked'),
        ],
        'OpenAI has published the release schedule for the current quarter.'
      );
      if (passed) {
        const article = await result;
        expect(article.content).toContain('OpenAGI publicly confirmed');
      } else {
        await expect(result).rejects.toThrow('Article validation failed');
      }

      const expectedAttempts = stage === 'resolution' && !passed ? 2 : 1;
      expect(completion).toHaveBeenCalledTimes(expectedAttempts);
      expect(quality).toHaveBeenCalledTimes(expectedAttempts);
      for (const call of completion.mock.calls) {
        expect(call[0]).toContain(publicFact);
        expect(call[0]).toContain(leakedFact);
        expect(call[0]).not.toContain(privateFact);
        expect(call[0]).not.toContain('Unleaked negotiation details.');
      }
      for (const call of quality.mock.calls) {
        expect(call[1]).toContain(publicFact.replace('OpenAI', 'OpenAGI'));
        expect(call[1]).toContain(leakedFact.replace('OpenAI', 'OpenAGI'));
        expect(call[1]).not.toContain(privateFact);
        expect(call[1]).not.toContain('Unleaked negotiation details.');
      }
      const prompt = completion.mock.calls[0]?.[0];
      expect(prompt).toContain(publicFact);
      expect(prompt).toContain(leakedFact);
      expect(prompt).not.toContain(privateFact);
      expect(prompt).not.toContain('Unleaked negotiation details.');
      expect(prompt).not.toContain('fabricated but realistic');
      expect(prompt).toContain('otherwise paraphrase');
      if (stage === 'resolution') {
        const primaryEvent = String(prompt)
          .split('=== EVENT TO COVER ===')[1]
          ?.split('Type:')[0];
        expect(primaryEvent).toContain(currentQuestion.text);
        expect(primaryEvent).toContain(
          `Resolved outcome: ${outcome ? 'YES' : 'NO'}`
        );
        expect(primaryEvent).toContain(publicFact);
        expect(primaryEvent).toContain(leakedFact);
        expect(prompt).toContain('100-150 words');
        expect(prompt).not.toContain('800-1500 words');
      } else {
        expect(prompt).toContain('800-1500 words');
      }
      const source = quality.mock.calls[0]?.[1];
      expect(source).toContain(publicFact.replace('OpenAI', 'OpenAGI'));
      expect(source).toContain(leakedFact.replace('OpenAI', 'OpenAGI'));
      expect(source).not.toContain(privateFact);
      expect(source).not.toContain('Unleaked negotiation details.');
      expect(source).not.toContain('OpenAI');
    });
  }
});
