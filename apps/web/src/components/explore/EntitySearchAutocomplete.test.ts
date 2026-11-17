import { describe, expect, it } from 'bun:test';
import { buildAutocompleteEntities } from './EntitySearchAutocomplete';

/**
 * The explore/sidebar autocomplete must only suggest real, discoverable
 * people: the autocomplete API mode filters before its bounded window,
 * while default registry requests keep every membership kind for admin.
 * This mapper also excludes test accounts (isTest flag or a 'test-' id prefix) and
 * banned accounts are not real people; NPC users arrive via the actors
 * array instead of the users array.
 */
describe('buildAutocompleteEntities', () => {
  it('keeps a regular user and maps it as a user entity', () => {
    const entities = buildAutocompleteEntities({
      users: [
        {
          id: 'user-1',
          name: 'Alice',
          username: 'alice',
          bio: 'hello',
          imageUrl: 'https://example.com/a.png',
        },
      ],
      actors: [],
    });

    expect(entities).toEqual([
      {
        id: 'user-1',
        name: 'Alice',
        username: 'alice',
        bio: 'hello',
        imageUrl: 'https://example.com/a.png',
        type: 'user',
      },
    ]);
  });

  it('drops test accounts by flag and by test- id prefix', () => {
    const entities = buildAutocompleteEntities({
      users: [
        { id: 'user-2', name: 'Flagged', isTest: true },
        { id: 'test-123', name: 'Prefixed' },
        { id: 'user-3', name: 'Real' },
      ],
      actors: [],
    });

    expect(entities.map((e) => e.id)).toEqual(['user-3']);
  });

  it('drops banned users', () => {
    const entities = buildAutocompleteEntities({
      users: [
        { id: 'user-4', name: 'Banned', isBanned: true },
        { id: 'user-5', name: 'Real' },
      ],
      actors: [],
    });

    expect(entities.map((e) => e.id)).toEqual(['user-5']);
  });

  it('drops NPC users from the users array but keeps static actors', () => {
    const entities = buildAutocompleteEntities({
      users: [{ id: 'npc-1', name: 'Npc User Row', isActor: true }],
      actors: [
        {
          id: 'actor-1',
          name: 'Npc Actor',
          description: 'trades',
          imageUrl: undefined,
        },
      ],
    });

    expect(entities).toEqual([
      {
        id: 'actor-1',
        name: 'Npc Actor',
        username: undefined,
        bio: 'trades',
        imageUrl: undefined,
        type: 'actor',
      },
    ]);
  });

  it('tolerates a payload without users or actors arrays', () => {
    expect(buildAutocompleteEntities({})).toEqual([]);
  });
});
