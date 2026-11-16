import { describe, expect, it } from 'bun:test';
import {
  validateCreateCommentArgs,
  validateCreatePostArgs,
} from '../../../mcp/src/utils/tool-args-validation';

describe('MCP create content validation', () => {
  it('rejects space-only post content', () => {
    expect(() => validateCreatePostArgs({ content: '   ' })).toThrow();
  });

  it('rejects tab and newline-only post content', () => {
    expect(() => validateCreatePostArgs({ content: '\t\n' })).toThrow();
  });

  it('trims padded post content', () => {
    expect(validateCreatePostArgs({ content: '  hello  ' }).content).toBe(
      'hello'
    );
  });

  it('accepts normal post content', () => {
    expect(validateCreatePostArgs({ content: 'Hello world' }).content).toBe(
      'Hello world'
    );
  });

  it('accepts exactly 5000 non-space characters in post content', () => {
    const content = 'x'.repeat(5000);
    expect(validateCreatePostArgs({ content }).content).toHaveLength(5000);
  });

  it('rejects 5001 non-space characters in post content', () => {
    expect(() =>
      validateCreatePostArgs({ content: 'x'.repeat(5001) })
    ).toThrow();
  });

  it('trims post content before applying the website-aligned 5000-character limit', () => {
    const content = ` ${'x'.repeat(5000)} `;
    expect(validateCreatePostArgs({ content }).content).toHaveLength(5000);
  });

  it('rejects space-only comment content', () => {
    expect(() =>
      validateCreateCommentArgs({ postId: 'p1', content: '   ' })
    ).toThrow();
  });

  it('rejects tab and newline-only comment content', () => {
    expect(() =>
      validateCreateCommentArgs({ postId: 'p1', content: '\t\n' })
    ).toThrow();
  });

  it('trims padded comment content', () => {
    expect(
      validateCreateCommentArgs({ postId: 'p1', content: '  hi  ' }).content
    ).toBe('hi');
  });

  it('accepts exactly 2000 non-space characters in comment content', () => {
    const content = 'x'.repeat(2000);
    expect(
      validateCreateCommentArgs({ postId: 'p1', content }).content
    ).toHaveLength(2000);
  });

  it('rejects 2001 non-space characters in comment content', () => {
    expect(() =>
      validateCreateCommentArgs({ postId: 'p1', content: 'x'.repeat(2001) })
    ).toThrow();
  });
});
