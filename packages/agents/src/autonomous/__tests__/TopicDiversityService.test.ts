import { expect, spyOn, test } from 'bun:test';
import { TopicDiversityService } from '../TopicDiversityService';

test('a fresh post leaves expired samples and authors out of the same topic', () => {
  const tracker = new TopicDiversityService();
  const topic = 'city_observatory';
  const expired = 'Introduce an astronomy workshop with starlight telescopes';
  const fresh = 'Coldest winter weekday brought delays downtown';
  const now = Date.now();
  const clock = spyOn(Date, 'now').mockReturnValue(now);
  try {
    tracker.recordTopicCoverage('original-npc', expired, topic, new Date(now));
    clock.mockReturnValue(now + 29 * 60 * 1000);
    tracker.recordTopicCoverage(
      'fresh-npc',
      fresh,
      topic,
      new Date(Date.now())
    );
    expect(tracker.isTooSimilarToRecent(expired).isSimilar).toBe(true);

    clock.mockReturnValue(now + 30 * 60 * 1000);
    expect(tracker.isTooSimilarToRecent(expired).isSimilar).toBe(false);
    expect(tracker.canPostAboutTopic('original-npc', topic).canPost).toBe(true);
    expect(tracker.canPostAboutTopic('fresh-npc', topic).canPost).toBe(false);
    expect(tracker.isTooSimilarToRecent(fresh).isSimilar).toBe(true);
    expect(tracker.getDiversityInstructions('original-npc')).not.toContain(
      topic
    );
    expect(tracker.getDiversityInstructions('fresh-npc')).toContain(topic);
  } finally {
    clock.mockRestore();
  }
});

test('posting again does not extend the lifetime of an earlier phrase', () => {
  const tracker = new TopicDiversityService();
  const now = Date.now();
  const clock = spyOn(Date, 'now').mockReturnValue(now);
  try {
    tracker.recordAgentPhrases('npc', 'Expect mean reversion', new Date(now));
    clock.mockReturnValue(now + 29 * 60 * 1000);
    tracker.recordAgentPhrases(
      'npc',
      'This has become exit liquidity',
      new Date(Date.now())
    );
    expect(
      tracker.hasRepetitivePhrases('npc', 'A new mean reversion').hasRepetition
    ).toBe(true);

    clock.mockReturnValue(now + 30 * 60 * 1000);
    expect(
      tracker.hasRepetitivePhrases('npc', 'A new mean reversion').hasRepetition
    ).toBe(false);
    expect(
      tracker.hasRepetitivePhrases('npc', 'More exit liquidity').hasRepetition
    ).toBe(true);
  } finally {
    clock.mockRestore();
  }
});
