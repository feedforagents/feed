import { describe, expect, it } from 'bun:test';
import {
  calculateModelPilotEstimateRange,
  modelPilotDeliverableAffectsEstimate,
} from '@feed/shared';

describe('model pilot inquiry helpers', () => {
  it('treats lowercase fine-tuned deliverables as estimate-affecting', () => {
    expect(
      modelPilotDeliverableAffectsEstimate('Dataset + fine-tuned model')
    ).toBe(true);
  });

  it('adds a surcharge for each of private deployment and data exclusivity', () => {
    const baseInput = {
      deliverables: ['Behavioral data'] as const,
      review: 'Light review' as const,
      concurrentAgents: 500,
      scenarioRuns: 10_000,
    };

    // Neither deployment option: no surcharge.
    expect(
      calculateModelPilotEstimateRange({
        ...baseInput,
        privateDeployment: false,
        dataExclusivity: false,
      })
    ).toBe('$7,000 – $12,000');

    // Each option on its own adds the surcharge once.
    expect(
      calculateModelPilotEstimateRange({
        ...baseInput,
        privateDeployment: true,
        dataExclusivity: false,
      })
    ).toBe('$15,000 – $26,000');
    expect(
      calculateModelPilotEstimateRange({
        ...baseInput,
        privateDeployment: false,
        dataExclusivity: true,
      })
    ).toBe('$15,000 – $26,000');

    // Both options together: the form states each adds a surcharge,
    // so the estimate must rise again over either option alone.
    expect(
      calculateModelPilotEstimateRange({
        ...baseInput,
        privateDeployment: true,
        dataExclusivity: true,
      })
    ).toBe('$22,000 – $41,000');
  });

  it('includes dataset plus fine-tuned model in the estimate uplift', () => {
    expect(
      calculateModelPilotEstimateRange({
        deliverables: ['Behavioral data'],
        review: 'Light review',
        privateDeployment: false,
        dataExclusivity: false,
        concurrentAgents: 500,
        scenarioRuns: 10_000,
      })
    ).toBe('$7,000 – $12,000');

    expect(
      calculateModelPilotEstimateRange({
        deliverables: ['Dataset + fine-tuned model'],
        review: 'Light review',
        privateDeployment: false,
        dataExclusivity: false,
        concurrentAgents: 500,
        scenarioRuns: 10_000,
      })
    ).toBe('$19,000 – $29,000');
  });
});
