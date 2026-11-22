import { describe, expect, it } from 'bun:test';
import { validateUpdateProfileArgs } from '../../../mcp/src/utils/tool-args-validation';

describe('MCP update_profile argument validation', () => {
  it('rejects values the website profile route rejects', () => {
    for (const args of [
      { username: 'no spaces allowed' },
      { username: 'ab' },
      { username: 'x'.repeat(31) },
      { displayName: 'x'.repeat(101) },
      { bio: 'x'.repeat(501) },
      { profileImageUrl: 'javascript:alert(1)' },
      { profileImageUrl: 'not a url' },
    ]) {
      expect(() => validateUpdateProfileArgs(args)).toThrow();
    }
  });

  it('accepts and trims valid values', () => {
    expect(
      validateUpdateProfileArgs({
        username: 'agent_007',
        displayName: '  Agent Seven  ',
        bio: ' hi ',
        profileImageUrl: 'https://example.com/a.png',
      })
    ).toEqual({
      username: 'agent_007',
      displayName: 'Agent Seven',
      bio: 'hi',
      profileImageUrl: 'https://example.com/a.png',
    });
    expect(
      validateUpdateProfileArgs({ profileImageUrl: '/uploads/a.png' })
    ).toEqual({ profileImageUrl: '/uploads/a.png' });
  });
});
