import type { MultiStepDecision } from './templates/multi-step-decision';

export function stripThinkBlocks(text: string): string {
  const withoutBlocks = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  return withoutBlocks.replace(/<\/?think>/gi, '').trim();
}

function unwrapCodeFence(text: string): string {
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fencedMatch?.[1]?.trim() || text;
}

/**
 * Extract the first balanced JSON object from an arbitrary model response.
 * This is more reliable than a greedy regex when models emit thinking tags,
 * code fences, or multiple brace-delimited regions.
 */
export function extractFirstJsonObject(response: string): string | null {
  const cleaned = unwrapCodeFence(stripThinkBlocks(response)).trim();

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < cleaned.length; index++) {
    const character = cleaned[index];
    if (!character) {
      continue;
    }

    if (start === -1) {
      if (character === '{') {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character === '{') {
      depth += 1;
      continue;
    }

    if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return cleaned.slice(start, index + 1);
      }
    }
  }

  return null;
}

export class DecisionValidationError extends Error {}

/** Validate model output before normalization can turn missing values into actions. */
export function parseDecisionJson(
  json: string
): Omit<MultiStepDecision, 'isFinish'> {
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DecisionValidationError('Decision must be an object');
  }
  if (
    !('action' in value) ||
    typeof value.action !== 'string' ||
    !value.action.trim() ||
    !('thought' in value) ||
    typeof value.thought !== 'string' ||
    !value.thought.trim() ||
    ('isFinish' in value && typeof value.isFinish !== 'boolean') ||
    !('parameters' in value) ||
    !value.parameters ||
    typeof value.parameters !== 'object' ||
    Array.isArray(value.parameters)
  ) {
    throw new DecisionValidationError(
      'Decision requires action, thought, and object parameters; isFinish, if provided, must be boolean'
    );
  }
  return {
    action: value.action,
    thought: value.thought,
    parameters: value.parameters as Record<string, unknown>,
  };
}
