import { describe, expect, it } from 'bun:test';
import { getActorRoleSignal } from '../services/narrative-state-service';
import { QuestionArcPlanner } from '../services/question-arc-planner';
import type { Actor, Organization, Question } from '../types';

function seededRng(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const question: Question = {
  id: 1,
  text: 'Will TechCorp ship the product?',
  scenario: 1,
  outcome: true,
  rank: 1,
};

describe('QuestionArcPlanner phase targets', () => {
  it('declared phase targets match the generated schedule, red herrings included', () => {
    for (const seed of [1, 7, 42, 1234]) {
      const plan = new QuestionArcPlanner().planQuestionArc(
        question,
        [],
        [],
        seededRng(seed)
      );

      const declaredTotal = Object.values(plan.phases).reduce(
        (sum, phase) => sum + phase.targetEventsTotal,
        0
      );
      expect(declaredTotal).toBe(plan.eventSchedule.length);

      for (const phase of Object.values(plan.phases)) {
        const [start, end] = phase.daysRange;
        const inPhase = plan.eventSchedule.filter(
          (e) => e.baseDay >= start && e.baseDay <= end
        );
        expect(inPhase).toHaveLength(phase.targetEventsTotal);
        expect(inPhase.filter((e) => e.signalDirection === 'NO')).toHaveLength(
          phase.targetWrongSignals
        );
      }
    }
  });
});

describe('QuestionArcPlanner role assignment', () => {
  const organizations: Organization[] = [
    {
      id: 'org-tech',
      name: 'TechCorp',
      description: 'A technology company',
      type: 'company',
      canBeInvolved: true,
    },
  ];

  const actors: Actor[] = [
    {
      id: 'insider-contrarian',
      name: 'Alex Insider',
      description: 'Executive who also has a contrarian streak',
      tier: 'S_TIER',
      role: 'main',
      personality: 'contrarian',
      domain: ['tech', 'politics'],
      affiliations: ['org-tech'],
    },
    {
      id: 'outsider-deceiver',
      name: 'Dana Skeptic',
      description: 'Spreads conspiracy theories',
      tier: 'B_TIER',
      role: 'supporting',
      personality: 'conspiracy theorist',
      domain: ['politics'],
      affiliations: [],
    },
  ];

  it('never assigns the same actor as both insider and deceiver', () => {
    for (const seed of [1, 2, 7, 42, 99, 1234]) {
      const plan = new QuestionArcPlanner().planQuestionArc(
        question,
        actors,
        organizations,
        seededRng(seed)
      );

      expect(plan.insiders).toEqual(['insider-contrarian']);
      expect(plan.deceivers).toEqual(['outsider-deceiver']);
      for (const deceiverId of plan.deceivers) {
        expect(plan.insiders).not.toContain(deceiverId);
        expect(
          getActorRoleSignal(
            {
              insiderActorIds: plan.insiders,
              deceiverActorIds: plan.deceivers,
            },
            deceiverId,
            question.outcome
          )
        ).toEqual({ direction: 'NO', reason: 'deceiver' });
      }
    }
  });

  it('leaves deceivers empty when the only deceiver-eligible actor is already an insider', () => {
    const plan = new QuestionArcPlanner().planQuestionArc(
      question,
      [actors[0]!],
      organizations,
      seededRng(7)
    );

    expect(plan.insiders).toEqual(['insider-contrarian']);
    expect(plan.deceivers).toEqual([]);
  });
});
