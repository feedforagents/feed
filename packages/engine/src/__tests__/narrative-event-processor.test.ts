/**
 * Narrative Event Processor Test Suite
 *
 * Tests for arc state machine, state transitions, and event generation.
 */

import { describe, expect, test } from 'bun:test';
import type { ArcStateType, PendingTransition } from '@feed/db';
import {
  evaluateStateTransition,
  getExpectedState,
  getNextScheduledEvent,
  scheduledEventHour,
  shouldGenerateEvent,
} from '../services/narrative-event-processor';
import type { ScheduledEvent } from '../services/question-arc-planner';
import { getGameDayNumber } from '../utils/date-utils';

// Mock arc state for testing
const createMockArcState = (
  overrides: Partial<{
    id: string;
    questionId: string;
    currentState: ArcStateType;
    lastEventAt: Date | null;
    pendingTransitions: PendingTransition[] | null;
  }> = {}
) => ({
  id: 'arc-1',
  questionId: 'q-1',
  currentState: 'setup' as ArcStateType,
  stateEnteredAt: new Date(),
  eventsGenerated: 0,
  lastEventAt: null,
  pendingTransitions: [],
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('Narrative Event Processor - Expected State Calculation', () => {
  test('days 1-3 should be setup phase', () => {
    expect(getExpectedState(1)).toBe('setup');
    expect(getExpectedState(2)).toBe('setup');
    expect(getExpectedState(3)).toBe('setup');
  });

  test('days 4-10 should be tension phase', () => {
    expect(getExpectedState(4)).toBe('tension');
    expect(getExpectedState(7)).toBe('tension');
    expect(getExpectedState(10)).toBe('tension');
  });

  test('days 11-18 should be escalation phase', () => {
    expect(getExpectedState(11)).toBe('escalation');
    expect(getExpectedState(15)).toBe('escalation');
    expect(getExpectedState(18)).toBe('escalation');
  });

  test('days 19-24 should be crisis phase', () => {
    expect(getExpectedState(19)).toBe('crisis');
    expect(getExpectedState(22)).toBe('crisis');
    expect(getExpectedState(24)).toBe('crisis');
  });

  test('days 25-27 should be revelation phase', () => {
    expect(getExpectedState(25)).toBe('revelation');
    expect(getExpectedState(26)).toBe('revelation');
    expect(getExpectedState(27)).toBe('revelation');
  });

  test('days 28-30 should be resolution phase', () => {
    expect(getExpectedState(28)).toBe('resolution');
    expect(getExpectedState(29)).toBe('resolution');
    expect(getExpectedState(30)).toBe('resolution');
  });

  test('days after 30 should remain in resolution', () => {
    expect(getExpectedState(31)).toBe('resolution');
    expect(getExpectedState(50)).toBe('resolution');
    expect(getExpectedState(100)).toBe('resolution');
  });
});

describe('Narrative Event Processor - State Transitions', () => {
  test('returns null when state matches expected', () => {
    const arc = createMockArcState({ currentState: 'setup' });
    const result = evaluateStateTransition(arc, 2); // Day 2 = setup
    expect(result).toBeNull();
  });

  test('returns new state when expected state differs', () => {
    const arc = createMockArcState({ currentState: 'setup' });
    const result = evaluateStateTransition(arc, 5); // Day 5 = tension
    expect(result).toBe('tension');
  });

  test('handles transition from setup to tension', () => {
    const arc = createMockArcState({ currentState: 'setup' });
    const result = evaluateStateTransition(arc, 4); // Day 4 = start of tension
    expect(result).toBe('tension');
  });

  test('handles transition from tension to escalation', () => {
    const arc = createMockArcState({ currentState: 'tension' });
    const result = evaluateStateTransition(arc, 11); // Day 11 = start of escalation
    expect(result).toBe('escalation');
  });

  test('handles transition to crisis', () => {
    const arc = createMockArcState({ currentState: 'escalation' });
    const result = evaluateStateTransition(arc, 19); // Day 19 = start of crisis
    expect(result).toBe('crisis');
  });

  test('handles transition to revelation', () => {
    const arc = createMockArcState({ currentState: 'crisis' });
    const result = evaluateStateTransition(arc, 25); // Day 25 = start of revelation
    expect(result).toBe('revelation');
  });

  test('handles transition to resolution', () => {
    const arc = createMockArcState({ currentState: 'revelation' });
    const result = evaluateStateTransition(arc, 28); // Day 28 = start of resolution
    expect(result).toBe('resolution');
  });

  test('checks pending transitions with probability', () => {
    const arc = createMockArcState({
      currentState: 'tension',
      pendingTransitions: [
        { targetState: 'crisis', triggerDay: 5, probability: 1.0 }, // 100% probability
      ],
    });
    const result = evaluateStateTransition(arc, 6); // Day 6, should trigger pending
    // Day 6 is still tension phase, so expectedState === currentState
    // Pending transition with probability 1.0 should fire
    expect(result).toBe('crisis');
  });

  test('respects pending transition probability', () => {
    const arc = createMockArcState({
      currentState: 'tension',
      pendingTransitions: [
        { targetState: 'crisis', triggerDay: 5, probability: 0 }, // 0% probability
      ],
    });

    // With 0% probability, should deterministically return null (no transition)
    const result = evaluateStateTransition(arc, 6);
    // A 0% pending transition should not trigger, so result should be null
    expect(result).toBe(null);
  });
});

describe('Narrative Event Processor - Event Generation Decision', () => {
  test('should not generate event during cooldown', () => {
    const arc = createMockArcState({
      currentState: 'tension',
      lastEventAt: new Date(Date.now() - 30 * 60 * 1000), // 30 minutes ago
    });

    // Cooldown is 2 hours, so should not generate
    expect(shouldGenerateEvent(arc)).toBe(false);
  });

  test('may generate event after cooldown period', () => {
    const arc = createMockArcState({
      currentState: 'crisis', // Higher probability (0.6)
      lastEventAt: new Date(Date.now() - 3 * 60 * 60 * 1000), // 3 hours ago
    });

    // Deterministically test with injected RNG
    // Crisis state has 0.6 probability, so rand() returning 0.5 should trigger generation
    const shouldGenerate = shouldGenerateEvent(arc, () => 0.5);
    expect(shouldGenerate).toBe(true);

    // RNG returning 0.7 should NOT trigger (0.7 >= 0.6)
    const shouldNotGenerate = shouldGenerateEvent(arc, () => 0.7);
    expect(shouldNotGenerate).toBe(false);
  });

  test('may generate event when no previous event', () => {
    const arc = createMockArcState({
      currentState: 'escalation', // 0.5 probability
      lastEventAt: null,
    });

    // Deterministically test with injected RNG
    // Escalation state has 0.5 probability, so rand() returning 0.4 should trigger generation
    const shouldGenerate = shouldGenerateEvent(arc, () => 0.4);
    expect(shouldGenerate).toBe(true);

    // RNG returning 0.6 should NOT trigger (0.6 >= 0.5)
    const shouldNotGenerate = shouldGenerateEvent(arc, () => 0.6);
    expect(shouldNotGenerate).toBe(false);
  });

  test('resolution phase has lower event probability', () => {
    const arcCrisis = createMockArcState({
      currentState: 'crisis',
      lastEventAt: null,
    });
    const arcResolution = createMockArcState({
      currentState: 'resolution',
      lastEventAt: null,
    });

    // Count event generations for each with a larger sample size
    let crisisCount = 0;
    let resolutionCount = 0;
    const iterations = 1000;

    // Use a simple seeded pseudo-random number generator for deterministic results
    let seed = 12345;
    const seededRandom = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    for (let i = 0; i < iterations; i++) {
      if (shouldGenerateEvent(arcCrisis, seededRandom)) crisisCount++;
      if (shouldGenerateEvent(arcResolution, seededRandom)) resolutionCount++;
    }

    // Crisis (0.6) should generate more than resolution (0.2)
    // With 1000 iterations, expect roughly 600 vs 200, so difference should exceed 100
    expect(crisisCount).toBeGreaterThan(resolutionCount);
    expect(crisisCount - resolutionCount).toBeGreaterThan(100);
  });
});

describe('Narrative Event Processor - Edge Cases', () => {
  test('handles day number 0', () => {
    // Day 0 is out-of-range (days are 1-indexed), returns 'resolution' as safe fallback
    const result = getExpectedState(0);
    expect(result).toBe('resolution');
  });

  test('handles negative day numbers', () => {
    const result = getExpectedState(-5);
    // Negative days return 'resolution' as safe fallback
    expect(result).toBe('resolution');
  });

  test('handles very large day numbers', () => {
    const result = getExpectedState(1000);
    expect(result).toBe('resolution');
  });

  test('handles empty pending transitions array', () => {
    const arc = createMockArcState({
      currentState: 'setup',
      pendingTransitions: [],
    });
    const result = evaluateStateTransition(arc, 2);
    expect(result).toBeNull(); // Still in setup, no transition
  });

  test('handles null pending transitions', () => {
    const arc = createMockArcState({
      currentState: 'setup',
      pendingTransitions: null,
    });
    // Should handle null gracefully
    const result = evaluateStateTransition(arc, 2);
    expect(result).toBeNull();
  });
});

function scheduled(
  overrides: Pick<ScheduledEvent, 'baseDay' | 'jitterHours'>
): ScheduledEvent {
  return {
    baseDay: overrides.baseDay,
    jitterHours: overrides.jitterHours,
    eventType: 'rumor',
    description: 'scheduled rumor',
    signalDirection: 'YES',
    fired: false,
  };
}

describe('scheduled world events use game time', () => {
  test('hour is elapsed time from game start in every host timezone', () => {
    // These instants are 12 hours apart, so a wall-clock hour cannot be 8
    // for both. Game hour is 8 for both because each clock starts 8.5h earlier.
    const starts = [
      new Date('2026-11-06T15:00:00.000Z'),
      new Date('2026-11-06T03:00:00.000Z'),
    ];
    for (const startedAt of starts) {
      const now = new Date(startedAt.getTime() + (8 * 60 + 30) * 60 * 1000);
      expect(scheduledEventHour(startedAt, now)).toBe(8);
    }
  });

  test('an event eight game hours in does not fire after ninety minutes', () => {
    const startedAt = new Date('2026-11-06T15:00:00.000Z');
    const now = new Date(startedAt.getTime() + 90 * 60 * 1000);
    const event = scheduled({ baseDay: 1, jitterHours: 8 });
    const hour = scheduledEventHour(startedAt, now);

    expect(getGameDayNumber(startedAt, now)).toBe(1);
    expect(hour).toBe(1);
    expect(getNextScheduledEvent([event], 1, hour)).toBeNull();
  });

  test('negative jitter fires on the previous game day at the shifted hour', () => {
    const startedAt = new Date('2026-11-06T15:00:00.000Z');
    // baseDay 2 plus -4 hours is game day 1 at hour 20.
    const event = scheduled({ baseDay: 2, jitterHours: -4 });
    const before = new Date(startedAt.getTime() + 19 * 60 * 60 * 1000);
    const due = new Date(startedAt.getTime() + 20 * 60 * 60 * 1000);

    expect(getGameDayNumber(startedAt, before)).toBe(1);
    expect(scheduledEventHour(startedAt, before)).toBe(19);
    expect(
      getNextScheduledEvent([event], 1, scheduledEventHour(startedAt, before))
    ).toBeNull();
    expect(getGameDayNumber(startedAt, due)).toBe(1);
    expect(scheduledEventHour(startedAt, due)).toBe(20);
    expect(
      getNextScheduledEvent([event], 1, scheduledEventHour(startedAt, due))
    ).toBe(event);
  });

  test('a later game day fires an event whose hour has not come around again', () => {
    const event = scheduled({ baseDay: 1, jitterHours: 18 });
    expect(getNextScheduledEvent([event], 2, 3)).toBe(event);
  });

  test('missing game start keeps the host hour', () => {
    const now = new Date('2026-11-06T16:30:00.000Z');
    expect(scheduledEventHour(null, now)).toBe(now.getHours());
    expect(scheduledEventHour(new Date(Number.NaN), now)).toBe(now.getHours());
  });
});
