import { describe, expect, it } from 'bun:test';
import { decodePostCursor, encodePostCursor } from '../../db/src/post-cursor';

describe('post feed cursor', () => {
  it('round-trips timestamp and id', () => {
    const cursor = encodePostCursor(
      '2026-11-06T01:02:03.456Z',
      '376886778398769153'
    );
    expect(cursor).toBe('2026-11-06T01:02:03.456Z_376886778398769153');
    expect(decodePostCursor(cursor)).toEqual({
      timestamp: '2026-11-06T01:02:03.456Z',
      id: '376886778398769153',
    });
  });

  it('keeps ids that contain the separator', () => {
    const cursor = encodePostCursor(
      new Date('2026-11-06T00:00:00Z'),
      'post_a_b'
    );
    expect(decodePostCursor(cursor).id).toBe('post_a_b');
  });

  it('treats a bare ISO timestamp as a legacy cursor', () => {
    expect(decodePostCursor('2026-11-06T01:02:03.456Z')).toEqual({
      timestamp: '2026-11-06T01:02:03.456Z',
    });
  });

  it('passes malformed input through unchanged as a legacy cursor', () => {
    for (const raw of [
      'garbage',
      '_123',
      'not-a-date_123',
      '2026-11-06T00:00:00Z_',
    ]) {
      expect(decodePostCursor(raw)).toEqual({ timestamp: raw });
    }
  });
});
