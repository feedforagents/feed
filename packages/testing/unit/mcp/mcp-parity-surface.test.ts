import { describe, expect, it } from 'bun:test';
import { getAvailableTools } from '../../../mcp/src/server/mcp-server';
import {
  validateCreatePostArgs,
  validateGetLeaderboardArgs,
  validateGetPortfolioArgs,
  validateGetPostArgs,
  validateOpenPositionArgs,
  validateResolveMarketArgs,
  validateSearchAgentsArgs,
} from '../../../mcp/src/utils/tool-args-validation';

describe('MCP Parity Surface', () => {
  it('exposes the parity tools expected by QA clients', () => {
    const toolNames = new Set(getAvailableTools().map((tool) => tool.name));

    expect(toolNames.has('get_post')).toBe(true);
    expect(toolNames.has('search_agents')).toBe(true);
    expect(toolNames.has('get_portfolio')).toBe(true);
    expect(toolNames.has('resolve_market')).toBe(true);
  });

  it('retains appeals without exposing escrow tools', () => {
    const toolNames = getAvailableTools().map(({ name }) => name);

    expect(toolNames).toContain('appeal_ban');
    expect(toolNames.filter((name) => name.includes('escrow'))).toEqual([]);
  });

  it('accepts mediaUrl on create_post arguments', () => {
    const args = validateCreatePostArgs({
      content: 'Post with media',
      mediaUrl: 'https://example.com/image.png',
    });

    expect(args.mediaUrl).toBe('https://example.com/image.png');
    expect('type' in args).toBe(false);
  });

  it('accepts personal wallet rankings and rejects retired team scope', () => {
    expect(validateGetLeaderboardArgs({ type: 'wallet' }).type).toBe('wallet');
    expect(() => validateGetLeaderboardArgs({ type: 'team' })).toThrow();
  });

  it('validates new parity tool arguments', () => {
    expect(validateGetPostArgs({ postId: 'post-123' }).postId).toBe('post-123');
    expect(validateSearchAgentsArgs({ query: 'alpha', limit: 5 }).limit).toBe(
      5
    );
    expect(validateGetPortfolioArgs({})).toEqual({});
    expect(
      validateResolveMarketArgs({ marketId: 'market-123', resolution: true })
        .resolution
    ).toBe(true);
  });

  it('accepts only whole-number leverage on open_position', () => {
    const order = { ticker: 'NVDAI', side: 'LONG', amount: 100 };

    expect(validateOpenPositionArgs({ ...order, leverage: 2 }).leverage).toBe(
      2
    );
    expect(() =>
      validateOpenPositionArgs({ ...order, leverage: 2.5 })
    ).toThrow();

    const tool = getAvailableTools().find(
      (candidate) => candidate.name === 'open_position'
    );
    expect(tool?.inputSchema.properties.leverage).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 20,
    });
  });
});
