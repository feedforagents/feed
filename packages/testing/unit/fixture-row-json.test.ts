import { describe, expect, it } from 'bun:test';
import { fixtureRowJson } from '../integration/helpers/fixture-row-json';

function record(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Expected a fixture record');
  }
  return parsed as Record<string, unknown>;
}

describe('fixture composite JSON across retained schema columns', () => {
  it('supplies the five exact original INSERT defaults only when omitted', () => {
    expect(record(fixtureRowJson('User', { id: 'owned-user' }))).toEqual({
      id: 'owned-user',
      hasFarcaster: false,
      pointsAwardedForFarcaster: false,
      pointsAwardedForFarcasterFollow: false,
      showFarcasterPublic: true,
    });
    expect(record(fixtureRowJson('Chat', { id: 'owned-chat' }))).toEqual({
      id: 'owned-chat',
      nftGated: false,
    });
  });
  it('preserves explicit receipt values including NULL instead of normalizing them', () => {
    const receipt = {
      id: 'owned-user',
      hasFarcaster: true,
      pointsAwardedForFarcaster: null,
      pointsAwardedForFarcasterFollow: true,
      showFarcasterPublic: false,
    };
    expect(record(fixtureRowJson('User', receipt))).toEqual(receipt);
    expect(
      record(fixtureRowJson('Chat', { id: 'owned-chat', nftGated: null }))
    ).toEqual({ id: 'owned-chat', nftGated: null });
    expect(
      record(fixtureRowJson('Chat', { id: 'owned-chat', nftGated: true }))
    ).toEqual({ id: 'owned-chat', nftGated: true });
  });
  it('retains unknown fields and leaves the acquired receipt untouched', () => {
    const receipt = Object.freeze({
      id: 'owned-chat',
      unexpectedColumn: { foreign: true },
      name: 'control',
    });
    expect(record(fixtureRowJson('Chat', receipt))).toEqual({
      ...receipt,
      nftGated: false,
    });
    expect(Object.keys(receipt)).toEqual(['id', 'unexpectedColumn', 'name']);
    expect(record(fixtureRowJson('Chat', receipt))).not.toHaveProperty(
      'hasFarcaster'
    );
    expect(
      record(fixtureRowJson('User', { id: 'owned-user' }))
    ).not.toHaveProperty('nftGated');
  });
  it('preserves the existing serialization of all modeled dates, decimals and JSON', () => {
    const receipt = {
      id: 'owned-user',
      createdAt: new Date('2026-11-12T00:00:00.123Z'),
      balance: '1234567890.12',
      nullable: null,
      flags: { enabled: false },
    };
    const reconstructed = record(fixtureRowJson('User', receipt));
    const current = record(JSON.stringify(receipt));
    for (const key of Object.keys(receipt))
      expect(reconstructed[key]).toEqual(current[key]);
  });
});
