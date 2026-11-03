import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import {
  validateCharacterLimit,
  validateFeedPost,
  validateNoRealNames,
} from '../../prompts/validate-output';
import * as worldContext from '../../prompts/world-context';

describe('validate-output', () => {
  afterEach(() => mock.restore());
  test('empty or whitespace-only posts are invalid', () => {
    const result = validateFeedPost('   ', {
      maxLength: 280,
      postType: 'AMBIENT',
    });
    expect(result.isValid).toBe(false);
    expect(result.violations.some((v) => v.startsWith('EMPTY'))).toBe(true);
  });

  test('invalid maxLength is rejected instead of silently passing', () => {
    expect(() => validateCharacterLimit('hi', Number.NaN, 'AMBIENT')).toThrow();
    expect(() => validateCharacterLimit('hi', 0, 'AMBIENT')).toThrow();
  });

  test('ordinary words that are also brand names are allowed', () => {
    expect(
      validateNoRealNames(
        'Cautious optimism as the avalanche of compound interest hits a polygon.'
      )
    ).toEqual([]);
  });

  test('real names are still rejected, once per occurrence', () => {
    const violations = validateNoRealNames('Elon Musk tweeted again');
    expect(violations.length).toBeGreaterThanOrEqual(1);
    const mentions = violations.filter((v) => /elon\s*musk/i.test(v));
    expect(mentions.length).toBe(1);
  });

  test('accepts canonical parody names that overlap real names', () => {
    const realNames = worldContext.getForbiddenRealNames();
    const canonicalNames = worldContext.getParodyActorNames();
    const overlappingParodies = canonicalNames.filter((name) =>
      realNames.some((realName) =>
        name.toLowerCase().includes(realName.toLowerCase())
      )
    );
    expect(overlappingParodies).toContain('The DAIly Wire');
    expect(
      overlappingParodies.filter((name) => validateNoRealNames(name).length > 0)
    ).toEqual([]);
    const overlappingRealNames = realNames.filter((realName) =>
      overlappingParodies.some((name) =>
        name.toLowerCase().includes(realName.toLowerCase())
      )
    );
    expect(
      overlappingRealNames.filter(
        (name) =>
          !canonicalNames.includes(name) &&
          validateNoRealNames(name).length === 0
      )
    ).toEqual([]);
    expect(validateNoRealNames('Elon AIlon Musk Musk')).toEqual([]);
  });

  test('still rejects real spellings beside their canonical parody spellings', () => {
    const violations = validateNoRealNames(
      'The DAIly Wire quoted The Daily Wire. GAInzy disagreed with Gainzy.'
    );
    expect(violations).toHaveLength(2);
    expect(violations).toContain('FORBIDDEN: Contains real name "Gainzy"');
    expect(violations).toContain(
      'FORBIDDEN: Contains real name "The Daily Wire"'
    );
    expect(validateNoRealNames('The Daily Wire')).toEqual([
      'FORBIDDEN: Contains real name "The Daily Wire"',
    ]);
  });

  test('escapes canonical names and protects only complete name spans', () => {
    spyOn(worldContext, 'getParodyActorNames').mockReturnValue(['A.C.M.E AI']);
    spyOn(worldContext, 'getForbiddenRealNames').mockReturnValue([
      'A.C.M.E',
      'AxCxMxE',
    ]);
    expect(validateNoRealNames('A.C.M.E AI')).toEqual([]);
    expect(validateNoRealNames('A.C.M.E')).toEqual([
      'FORBIDDEN: Contains real name "A.C.M.E"',
    ]);
    expect(validateNoRealNames('AxCxMxE AI')).toEqual([
      'FORBIDDEN: Contains real name "AxCxMxE"',
    ]);
    expect(validateNoRealNames('A.C.M.E AIx')).toEqual([
      'FORBIDDEN: Contains real name "A.C.M.E"',
    ]);
  });
});
