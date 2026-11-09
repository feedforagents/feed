import { beforeEach, describe, expect, test } from 'bun:test';
import { usePendingIntent } from '@/hooks/usePendingIntent';
import {
  continuationProfileSchema,
  desiredActionUrl,
  isAlreadyDesiredResponse,
} from './execute-intent';
import {
  cancelPendingIntent,
  claimPendingIntent,
  INTENT_TTL_MS,
  PENDING_INTENT_KEY,
  parsePendingIntent,
  pendingActionSchema,
  savePendingIntent,
} from './pending-intent';

class TabStorage implements Storage {
  private values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}
const action = {
  kind: 'like',
  targetType: 'post',
  targetId: '123',
  desired: true,
} as const;
const envelope = (now: number) => ({
  version: 1,
  id: 'intent',
  createdAt: now,
  expiresAt: now + INTENT_TTL_MS,
  ownerId: null,
  action,
});
beforeEach(() => usePendingIntent.getState().clear());
describe('pending sign-in intent', () => {
  test('strictly validates shape, TTL, future timestamps and safe navigation', () => {
    const now = Date.now();
    expect(
      parsePendingIntent(JSON.stringify(envelope(now)), now)
    ).not.toBeNull();
    for (const value of [
      null,
      '{',
      JSON.stringify({ ...envelope(now), token: 'secret' }),
      JSON.stringify({ ...envelope(now), expiresAt: now + INTENT_TTL_MS + 1 }),
      JSON.stringify(envelope(now + 1)),
    ])
      expect(parsePendingIntent(value, now)).toBeNull();
    expect(
      parsePendingIntent(JSON.stringify(envelope(now)), now + INTENT_TTL_MS)
    ).toBeNull();
    for (const href of [
      'https://evil.test',
      '//evil.test',
      '/profile?token=secret',
      '/api/oauth/approve',
      '/wallet#private',
    ])
      expect(
        pendingActionSchema.safeParse({ kind: 'navigate', href }).success
      ).toBe(false);
  });
  test('claims synchronously once across callback, mount and reload; another tab is isolated', () => {
    const tab = new TabStorage();
    expect(savePendingIntent(action, null, tab)).toBe(true);
    const claimed = claimPendingIntent(tab);
    expect(claimed?.action).toEqual(action);
    expect(tab.getItem(PENDING_INTENT_KEY)).toBeNull();
    expect(claimPendingIntent(tab)).toBeNull();
    expect(claimPendingIntent(new TabStorage())).toBeNull();
  });
  test('cancel/back removes pending work and expiry removes invalid stored work', () => {
    const tab = new TabStorage();
    savePendingIntent(action, null, tab);
    cancelPendingIntent(tab);
    expect(claimPendingIntent(tab)).toBeNull();
    tab.setItem(
      PENDING_INTENT_KEY,
      JSON.stringify(envelope(Date.now() - INTENT_TTL_MS))
    );
    expect(claimPendingIntent(tab)).toBeNull();
    expect(tab.length).toBe(0);
  });
  test('a failed durable removal cannot return an executable intent', () => {
    const tab = new TabStorage();
    savePendingIntent(action, null, tab);
    tab.removeItem = () => {
      throw new DOMException('blocked', 'SecurityError');
    };
    expect(claimPendingIntent(tab)).toBeNull();
  });
  test('shared consumer gate cannot begin a duplicate and explicit clear releases it', () => {
    const intent = parsePendingIntent(JSON.stringify(envelope(Date.now())));
    if (!intent) throw new Error('test intent invalid');
    expect(usePendingIntent.getState().begin(intent, 'sessionA')).toBe(true);
    expect(usePendingIntent.getState().begin(intent, 'sessionA')).toBe(false);
    usePendingIntent.getState().clear();
    expect(usePendingIntent.getState().begin(intent, 'sessionB')).toBe(true);
  });
  test('fresh profile must contain canonical identity and persisted Terms acceptance', () => {
    const profile = {
      authenticated: true,
      needsOnboarding: false,
      user: {
        id: 'canonicalA',
        username: 'alice',
        profileComplete: true,
        tosAcceptedAt: '2026-11-09T00:00:00.000Z',
      },
    };
    expect(continuationProfileSchema.safeParse(profile).success).toBe(true);
    for (const user of [
      { ...profile.user, tosAcceptedAt: null },
      { ...profile.user, tosAcceptedAt: undefined },
      { ...profile.user, profileComplete: false },
      { ...profile.user, username: '' },
    ])
      expect(
        continuationProfileSchema.safeParse({ ...profile, user }).success
      ).toBe(false);
  });
  test('desired true maps only to add endpoints and recognizes exact production existing-state replies', () => {
    expect(desiredActionUrl(action)).toBe('/api/posts/123/like');
    expect(
      desiredActionUrl({ kind: 'follow', targetId: 'A/B', desired: true })
    ).toBe('/api/users/A%2FB/follow');
    expect(
      isAlreadyDesiredResponse(action, { error: 'Post already liked' })
    ).toBe(true);
    expect(
      isAlreadyDesiredResponse(
        { ...action, targetType: 'comment' },
        { error: 'Comment already liked' }
      )
    ).toBe(true);
    expect(
      isAlreadyDesiredResponse(
        { kind: 'follow', targetId: 'A', desired: true },
        { error: 'Already following this user' }
      )
    ).toBe(true);
    expect(isAlreadyDesiredResponse(action, { error: 'Post deleted' })).toBe(
      false
    );
    expect(
      isAlreadyDesiredResponse(action, { error: 'Comment already liked' })
    ).toBe(false);
    expect(
      pendingActionSchema.safeParse({ ...action, desired: false }).success
    ).toBe(false);
  });
});
