import { describe, expect, test } from 'bun:test';
import {
  getNotificationHref,
  type NotificationHrefInput,
} from '../../../apps/web/src/lib/notifications/presentation';

function input(
  overrides: Partial<NotificationHrefInput>
): NotificationHrefInput {
  return {
    type: 'system',
    message: '',
    actorId: null,
    postId: null,
    commentId: null,
    chatId: null,
    data: null,
    ...overrides,
  };
}

describe('getNotificationHref', () => {
  test('comment-bearing notifications arrive at the recorded comment', () => {
    for (const type of ['comment', 'reply', 'mention', 'reaction']) {
      expect(
        getNotificationHref(
          input({ type, postId: 'post1', commentId: 'comment1' })
        )
      ).toBe('/comment/comment1');
    }
  });

  test('post-level notifications still arrive at the post', () => {
    expect(
      getNotificationHref(input({ type: 'reaction', postId: 'post1' }))
    ).toBe('/post/post1');
    expect(getNotificationHref(input({ type: 'share', postId: 'post1' }))).toBe(
      '/post/post1'
    );
    expect(
      getNotificationHref(input({ type: 'mention', postId: 'post1' }))
    ).toBe('/post/post1');
  });

  test('existing targets are unchanged', () => {
    expect(getNotificationHref(input({ type: 'follow', actorId: 'u1' }))).toBe(
      '/profile/u1'
    );
    expect(getNotificationHref(input({ chatId: 'chat1' }))).toBe(
      '/chats?chat=chat1'
    );
    expect(getNotificationHref(input({ type: 'daily_summary' }))).toBe(
      '/notifications'
    );
    expect(
      getNotificationHref(
        input({ type: 'system', message: 'Edit your profile to continue' })
      )
    ).toBe('/settings');
    expect(getNotificationHref(input({ type: 'achievement_unlocked' }))).toBe(
      '/feed'
    );
  });

  test('market_resolved follows a same-origin deep link only', () => {
    expect(
      getNotificationHref(
        input({
          type: 'market_resolved',
          data: { deepLink: '/markets/predictions/m1' },
        })
      )
    ).toBe('/markets/predictions/m1');
    expect(
      getNotificationHref(
        input({
          type: 'market_resolved',
          data: { deepLink: 'https://evil.example/phish' },
        })
      )
    ).toBe('/feed');
  });
});
