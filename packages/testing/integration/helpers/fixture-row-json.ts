// Original baseline defaults retained by the approved staging additive path.
// Drizzle's current projection omits these retired fields. Supply only their
// known INSERT defaults to the expected composite, never values read later.
const retainedDefaults = {
  User: {
    hasFarcaster: false,
    pointsAwardedForFarcaster: false,
    pointsAwardedForFarcasterFollow: false,
    showFarcasterPublic: true,
  },
  Chat: { nftGated: false },
} as const;

export function fixtureRowJson(
  table: 'User' | 'Chat',
  receipt: object
): string {
  // Explicit acquired fields (including NULL) and every unknown field win.
  // PostgreSQL ignores these extra keys on the canonical schema that removed
  // them; the existing full physical composite comparison remains unchanged.
  return JSON.stringify({ ...retainedDefaults[table], ...receipt });
}
