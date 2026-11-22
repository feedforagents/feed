/**
 * Content Quality Gate Unit Tests
 *
 * Tests the write-side quality gate that validates content before DB insertion.
 * The gate runs structure + entity + grounding/coherence checks.
 *
 * Pure unit tests — no DB. Embedding-based grounding degrades gracefully
 * when OPENAI_API_KEY is absent, so these tests exercise the structural
 * and entity layers that run synchronously.
 */

import { describe, expect, test } from 'bun:test';
import { ContentQualityGate } from '@feed/engine';

describe('ContentQualityGate.validateParody', () => {
  test('grounded parody passes', async () => {
    const original = 'Tesla stock surges on record Q4 deliveries';
    const parody =
      'Teslaroid stock surges on record Q4 delivery drones becoming sentient';

    const result = await ContentQualityGate.validateParody(original, parody);
    expect(result.passed).toBe(true);
    expect(result.score).toBeGreaterThan(0);
    expect(result.reasons).toHaveLength(0);
  });

  test('verbatim copy fails structure check', async () => {
    const original = 'Apple announces iPhone 17 with new features';
    const parody = 'Apple announces iPhone 17 with new features';

    const result = await ContentQualityGate.validateParody(original, parody);
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('Verbatim copy'))).toBe(true);
  });

  test('too-short parody fails structure check', async () => {
    const original = 'Major tech company launches new product line';
    const parody = 'Short';

    const result = await ContentQualityGate.validateParody(original, parody);
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('Too short'))).toBe(true);
  });

  test('too-long parody fails structure check', async () => {
    const original = 'Brief headline';
    const parody = 'A'.repeat(600);

    const result = await ContentQualityGate.validateParody(original, parody);
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('Too long'))).toBe(true);
  });

  test('parody with content body validates coherence of body too', async () => {
    const original = 'SpaceX launches Starship successfully';
    const parody = 'SpaceXYZ launches Starship into parallel dimension';
    const body =
      'The rocket disappeared into a portal, witnesses report. Scientists are baffled by the new physics involved.';

    const result = await ContentQualityGate.validateParody(
      original,
      parody,
      body
    );
    // Should run coherence check on body without crashing
    expect(typeof result.passed).toBe('boolean');
    expect(typeof result.score).toBe('number');
  });

  test('parody allows entities present in originalTitle while still rejecting invented entities', async () => {
    const original =
      'Federal Reserve and European Union debate Silicon Valley regulation';
    const groundedParody =
      'Federal Reserve and European Union hold emergency Silicon Valley robot regulation summit';

    const groundedResult = await ContentQualityGate.validateParody(
      original,
      groundedParody
    );
    expect(groundedResult.passed).toBe(true);
    expect(groundedResult.reasons).toHaveLength(0);

    const fabricatedParody =
      'Quantum Harbor and Silver Archive debate regulation after Federal Reserve talk';
    const fabricatedResult = await ContentQualityGate.validateParody(
      original,
      fabricatedParody
    );
    expect(fabricatedResult.passed).toBe(false);
    expect(
      fabricatedResult.reasons.some((r) => r.includes('unknown entities'))
    ).toBe(true);
  });
});

describe('ContentQualityGate.validateWorldFact', () => {
  test('coherent fact without source passes', async () => {
    const fact =
      'The prediction markets are showing increased activity around upcoming product launches in the tech sector.';

    const result = await ContentQualityGate.validateWorldFact(fact);
    expect(result.passed).toBe(true);
    expect(result.score).toBeGreaterThan(0);
  });

  test('grounded fact with source context passes', async () => {
    const fact =
      'The prediction market activity around AI regulation has increased after the government released a new framework for oversight.';
    const source =
      'Government released new AI regulation framework. Prediction market activity surges on the news. Increased interest in oversight policy.';

    const result = await ContentQualityGate.validateWorldFact(fact, source);
    expect(result.passed).toBe(true);
  });

  test('too-short fact fails structure check', async () => {
    const fact = 'Short fact.';

    const result = await ContentQualityGate.validateWorldFact(fact);
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('Too short'))).toBe(true);
  });

  test('fact with many invented entities fails entity check', async () => {
    const fact =
      'John Fakerson and Clara Invented announced that the Bogus Foundation will partner with Hallucinated Corp to build something.';

    const result = await ContentQualityGate.validateWorldFact(fact);
    // Entity check should flag multiple unknown proper nouns
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('unknown entities'))).toBe(
      true
    );
  });

  test('world fact with sourceContext allows entities grounded in that source', async () => {
    const source =
      'Federal Reserve and European Union released joint Silicon Valley banking guidance.';
    const consolidated =
      'The Federal Reserve and European Union issued coordinated banking guidance affecting Silicon Valley lenders.';

    const groundedResult = await ContentQualityGate.validateWorldFact(
      consolidated,
      source
    );
    expect(groundedResult.passed).toBe(true);
    expect(groundedResult.reasons).toHaveLength(0);

    const hallucinated =
      'Quantum Harbor and Silver Archive issued banking guidance alongside the Federal Reserve.';
    const hallucinatedResult = await ContentQualityGate.validateWorldFact(
      hallucinated,
      source
    );
    expect(hallucinatedResult.passed).toBe(false);
    expect(
      hallucinatedResult.reasons.some((r) => r.includes('unknown entities'))
    ).toBe(true);
  });
});

describe('ContentQualityGate.validateArticle', () => {
  test('grounded article passes', async () => {
    const article =
      'The recent announcement from OpenAGI about their new reasoning model has sent shockwaves through the tech industry. Analysts predict this could reshape the competitive landscape, as rivals scramble to match the breakthrough capabilities demonstrated in early benchmarks. Market observers note that this development aligns with the broader trend of accelerating AI advancement.';
    const source =
      'OpenAGI announces breakthrough reasoning model. Industry analysts react. Competitors respond to the news.';

    const result = await ContentQualityGate.validateArticle(article, source);
    expect(result.passed).toBe(true);
    expect(result.score).toBeGreaterThan(0);
  });

  test('accepts a long article that covers every keyword in a short source', async () => {
    const source = 'Harbor dredging permits delayed.';
    const article =
      'Harbor dredging permits were delayed. The setback leaves contractors balancing vessel availability against the cost of idle equipment. Shipping operators are reviewing berth reservations and contingency plans as crews await a revised timetable. Smaller logistics companies face tighter margins because they have fewer alternatives when routes change. Workers could rotate through maintenance assignments while supervisors coordinate surveys and review safety procedures. Local businesses near the waterfront expect quieter weekdays if deliveries move elsewhere. The eventual opening date will depend on approval, weather conditions, and whether suppliers can meet the new sequence of work.';

    const result = await ContentQualityGate.validateArticle(article, source);
    expect(result).toMatchObject({ passed: true, reasons: [] });
  });

  test('allows source-mentioned product phrases with case differences', async () => {
    const source =
      'StrAItegy launches a viral meme coin at OpenAGI terminal secure Copilot. The launch uses Terminal Copilot for secure terminal access.';
    const article =
      'The launch of Meme Coin uses Terminal Copilot for secure terminal access. The viral meme coin launch uses the secure terminal for the product and its release.';
    const result = await ContentQualityGate.validateArticle(article, source);
    expect(result.passed).toBe(true);
    expect(
      result.reasons.some((reason) => reason.includes('unknown entities'))
    ).toBe(false);
  });

  test('rejects unrelated invented entities even when another name is sourced', async () => {
    const source =
      'StrAItegy launches a viral meme coin with Terminal Copilot for secure terminal access.';
    const article =
      'The launch of Meme Coin uses Terminal Copilot for secure terminal access. Quantum Harbor and Silver Archive announced the launch of the viral meme coin.';
    const result = await ContentQualityGate.validateArticle(article, source);
    expect(result.passed).toBe(false);
    expect(
      result.reasons.some((reason) => reason.includes('unknown entities'))
    ).toBe(true);
  });

  test('does not match entity phrases inside longer source words', async () => {
    const source =
      'StrAItegy launches a viral meme coinware with Terminal Copilot for secure terminal access.';
    const article =
      'The launch of Meme Coin uses Terminal Copilot for secure terminal access. Quantum Harbor announced the viral meme coin launch for terminal access.';
    const result = await ContentQualityGate.validateArticle(article, source);
    expect(result.passed).toBe(false);
    expect(
      result.reasons.some((reason) => reason.includes('unknown entities'))
    ).toBe(true);
  });

  test('too-short article fails structure check', async () => {
    const article = 'This is too short to be an article.';
    const source = 'Some event happened in the tech world.';

    const result = await ContentQualityGate.validateArticle(article, source);
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('Too short'))).toBe(true);
  });
});

describe('ContentQualityGate entity counting', () => {
  test('one unknown name repeated is counted once', async () => {
    const fact =
      'Zorblax Quentin announced a merger today. Analysts say Zorblax Quentin will expand further.';
    const result = await ContentQualityGate.validateWorldFact(fact);
    expect(result.reasons.some((r) => r.includes('unknown entities'))).toBe(
      false
    );
  });
});
