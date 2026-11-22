/** Stories rail cursor: findCursorIndex resolves the cursor by storyKey. */
import { describe, expect, it } from 'bun:test';
import type { NarrativeStory } from '@feed/shared';
import { findCursorIndex } from '../../../apps/web/src/app/api/feed/feed-cursor';

function story(storyKey: string, storyScore: number): NarrativeStory {
  return {
    storyKey,
    storyTitle: storyKey,
    questionNumber: null,
    arcState: null,
    storyScore,
    postCount: 0,
    posts: [],
    hasUserPosition: false,
  };
}

describe('findCursorIndex', () => {
  it('resumes after an interleaved low-score market card', () => {
    // spreadNewMarkets pulled the low-scored post story between two
    // higher-scored market cards, so the snapshot is no longer monotonic in
    // (score, storyKey) order and the binary search alone cannot find the
    // cursor. Page 1 served [A, M-market]; page 2 must start at B.
    const stories = [
      story('A', 100),
      story('M-market', 50),
      story('B', 85),
      story('C', 80),
      story('D', 75),
      story('E', 70),
      story('F', 68),
    ];
    expect(findCursorIndex(stories, { s: 50, k: 'M-market' })).toBe(2);
  });

  it('resumes after the second of two interleaved market cards', () => {
    const stories = [
      story('A', 100),
      story('M1', 50),
      story('B', 85),
      story('M2', 40),
      story('C', 80),
      story('D', 75),
      story('E', 70),
    ];
    expect(findCursorIndex(stories, { s: 40, k: 'M2' })).toBe(4);
  });

  it('keeps the binary-search result on a monotonic snapshot', () => {
    const stories = [
      story('A', 100),
      story('B', 90),
      story('C', 80),
      story('D', 70),
      story('E', 60),
      story('F', 50),
    ];
    expect(findCursorIndex(stories, { s: 80, k: 'C' })).toBe(3);
  });

  it('falls back to the binary search when the cursor story is gone', () => {
    const stories = [
      story('A', 100),
      story('B', 90),
      story('D', 70),
      story('E', 60),
      story('F', 50),
    ];
    expect(findCursorIndex(stories, { s: 80, k: 'C' })).toBe(2);
  });
});
