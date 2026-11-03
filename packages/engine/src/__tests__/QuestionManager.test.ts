/**
 * QuestionManager Test Suite
 *
 * @module engine/__tests__/QuestionManager.test
 *
 * @description
 * Comprehensive test suite for the QuestionManager prediction market question
 * lifecycle system. Verifies question creation, resolution, and constraint enforcement.
 *
 * **Test Coverage:**
 * - Question resolution detection (by date)
 * - Days until resolution calculation
 * - Question status transitions (active → resolved)
 * - Active vs resolved question filtering
 *
 * **Key Features Tested:**
 * - Date-based resolution triggering
 * - Day calculation accuracy
 * - Status tracking (active/resolved)
 * - Question filtering utilities
 *
 * **Testing Approach:**
 * - Unit tests with mock LLM client
 * - No external dependencies
 * - Pure function testing
 * - Edge case coverage
 *
 * @see {@link QuestionManager} - Class under test
 */

import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { FeedLLMClient } from '../llm/openai-client';
import { QuestionManager } from '../QuestionManager';
import type { Question } from '../types/shared';

/**
 * Mock LLM client interface for testing
 * Only implements the methods required by QuestionManager
 */
interface MockLLMClient
  extends Pick<FeedLLMClient, 'generateJSON' | 'getProvider' | 'getStats'> {}

// Mock LLM client for testing - implements MockLLMClient interface
const mockLLMImpl: MockLLMClient = {
  generateJSON: async <T>(): Promise<T> => {
    return { questions: [] } as T;
  },
  getProvider: () => 'groq',
  getStats: () => ({
    provider: 'groq' as const,
    model: 'test',
    totalTokens: 0,
    totalCost: 0,
  }),
};

// Cast to full FeedLLMClient type for QuestionManager compatibility
const mockLLM = mockLLMImpl as FeedLLMClient;

describe('QuestionManager', () => {
  afterEach(() => mock.restore());

  const resolutionQuestion: Question = {
    id: 1,
    text: 'Will OpenAGI publish its release schedule?',
    scenario: 1,
    outcome: true,
    rank: 1,
  };

  test('assesses proof for a supplied reason without generating the event twice', async () => {
    const manager = new QuestionManager(mockLLM);
    const description =
      'OpenAGI officially confirmed its published release schedule.';
    const event = spyOn(manager, 'generateResolutionEvent').mockResolvedValue(
      description
    );
    const proof = spyOn(manager, 'generateProofContent').mockResolvedValue(
      null
    );
    const combined = await manager.generateResolutionWithProof(
      resolutionQuestion,
      [],
      [],
      []
    );
    const staged = await manager.generateProofForResolution(
      resolutionQuestion,
      description,
      [],
      []
    );
    expect(staged).toEqual(combined);
    expect(staged).toMatchObject({
      confidence: 0.95,
      requiresManualReview: false,
      confidenceSignals: [],
    });
    expect(event).toHaveBeenCalledTimes(1);
    expect(proof).toHaveBeenCalledTimes(2);
    expect(proof.mock.calls[1]).toEqual([
      resolutionQuestion,
      description,
      [],
      [],
    ]);
  });

  test('retains the empty-evidence manual-review assessment', async () => {
    const manager = new QuestionManager(mockLLM);
    spyOn(manager, 'generateProofContent').mockResolvedValue(null);
    const result = await manager.generateProofForResolution(
      resolutionQuestion,
      '',
      [],
      []
    );
    expect(result.requiresManualReview).toBe(true);
    expect(result.confidence).toBe(0.2);
    expect(result.confidenceSignals).toEqual(['no_evidence']);
  });

  test('retains speculative confidence deductions for supplied evidence', async () => {
    const manager = new QuestionManager(mockLLM);
    spyOn(manager, 'generateProofContent').mockResolvedValue(null);
    const result = await manager.generateProofForResolution(
      resolutionQuestion,
      'An unconfirmed rumor describes a release.',
      [],
      []
    );
    expect(result.confidence).toBeCloseTo(0.45);
    expect(result.requiresManualReview).toBe(true);
    expect(result.confidenceSignals).toEqual(['rumor', 'unconfirmed']);
  });

  for (const response of [
    {},
    { event: '' },
    { event: '  ' },
    { event: { text: 'Not a string' } },
    { event: 42 },
  ]) {
    test(`rejects invalid resolution event ${JSON.stringify(response)} before world impact`, async () => {
      const manager = new QuestionManager(mockLLM);
      spyOn(mockLLM, 'generateJSON').mockResolvedValue(response);
      const impact = spyOn(
        manager as unknown as {
          assessAndRecordWorldImpact: (
            question: Question,
            event: string
          ) => Promise<void>;
        },
        'assessAndRecordWorldImpact'
      ).mockResolvedValue(undefined);
      await expect(
        manager.generateResolutionEvent(resolutionQuestion, [], [], [])
      ).rejects.toThrow('Resolution event must be a nonempty string');
      expect(impact).not.toHaveBeenCalled();
    });
  }

  test('detects questions that should be resolved', () => {
    const manager = new QuestionManager(mockLLM);
    const questions: Question[] = [
      {
        id: 1,
        text: 'Question 1',
        scenario: 1,
        outcome: true,
        rank: 1,
        createdDate: '2025-11-01',
        resolutionDate: '2025-11-03',
        status: 'active',
      },
      {
        id: 2,
        text: 'Question 2',
        scenario: 1,
        outcome: false,
        rank: 2,
        createdDate: '2025-11-01',
        resolutionDate: '2025-11-05',
        status: 'active',
      },
    ];

    const currentDate = '2025-11-03';

    // Question 1 should be resolved (resolutionDate <= currentDate)
    // Question 2 should not (resolutionDate > currentDate)
    const toResolve = manager.getQuestionsToResolve(questions, currentDate);

    expect(toResolve.length).toBe(1);
    expect(toResolve[0]!.id).toBe(1);
  });

  test('calculates days until resolution correctly', () => {
    const manager = new QuestionManager(mockLLM);
    const question: Question = {
      id: 1,
      text: 'Test Question',
      scenario: 1,
      outcome: true,
      rank: 1,
      createdDate: '2025-11-01',
      resolutionDate: '2025-11-05',
      status: 'active',
    };

    const currentDate = '2025-11-01';

    const diffDays = manager.getDaysUntilResolution(question, currentDate);

    expect(diffDays).toBe(4);
  });

  test('tracks question status transitions', () => {
    const manager = new QuestionManager(mockLLM);
    const question: Question = {
      id: 1,
      text: 'Test Question',
      scenario: 1,
      outcome: true,
      rank: 1,
      createdDate: '2025-11-01',
      resolutionDate: '2025-11-03',
      status: 'active',
    };

    // Resolve the question
    const resolved = manager.resolveQuestion(question, question.outcome);

    expect(resolved.status).toBe('resolved');
    expect(resolved.resolvedOutcome).toBe(true);
  });

  test('filters active vs resolved questions', () => {
    const manager = new QuestionManager(mockLLM);
    const questions: Question[] = [
      {
        id: 1,
        text: 'Question 1',
        scenario: 1,
        outcome: true,
        rank: 1,
        status: 'active',
      },
      {
        id: 2,
        text: 'Question 2',
        scenario: 1,
        outcome: false,
        rank: 2,
        status: 'resolved',
        resolvedOutcome: false,
      },
      {
        id: 3,
        text: 'Question 3',
        scenario: 1,
        outcome: true,
        rank: 3,
        status: 'active',
      },
    ];

    const active = manager.getActiveQuestions(questions);
    const resolved = manager.getResolvedQuestions(questions);

    expect(active.length).toBe(2);
    expect(resolved.length).toBe(1);
  });
});
