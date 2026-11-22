import { describe, expect, mock, test } from 'bun:test';

// PRD §12 keeps posts at 280 characters, and PRD §8.1 requires agent tools
// to apply the same business logic as the website. The web composer stops
// at 280, but the server-side gates accepted up to 5000 characters, so an
// agent (MCP create_post, A2A social.create_post) or a direct POST to
// /api/posts could publish posts the website itself never allows.
const actualDbModule = await import('@feed/db');

const userId = 'post-length-limit-user';
const createdPosts: Array<{ content: string }> = [];

const mockDb = {
  post: {
    create: mock(({ data }: { data: { id: string; content: string } }) => {
      createdPosts.push({ content: data.content });
      return Promise.resolve({ id: data.id, content: data.content });
    }),
  },
  chatParticipant: {
    findFirst: mock(() => Promise.resolve(null)),
  },
};

mock.module('@feed/db', () => ({
  ...actualDbModule,
  db: mockDb,
}));

const { CreatePostSchema, MAX_POST_LENGTH } = await import('@feed/shared');
const { validateCreatePostArgs } = await import(
  '../../mcp/src/utils/tool-args-validation'
);
const { FeedAgentExecutor } = await import(
  '../../a2a/src/executors/feed-executor'
);

const atLimit = 'a'.repeat(280);
const overLimit = 'a'.repeat(281);

describe('post content length limit (PRD §12: 280 characters)', () => {
  test('the shared limit is 280 characters', () => {
    expect(MAX_POST_LENGTH).toBe(280);
  });

  test('POST /api/posts body schema accepts 280 and rejects 281 characters', () => {
    const body = CreatePostSchema.pick({ content: true });
    expect(body.parse({ content: atLimit }).content).toHaveLength(280);
    expect(body.safeParse({ content: overLimit }).success).toBe(false);
  });

  test('MCP create_post accepts 280 and rejects 281 characters', () => {
    expect(validateCreatePostArgs({ content: atLimit }).content).toHaveLength(
      280
    );
    expect(() => validateCreatePostArgs({ content: overLimit })).toThrow();
  });

  test('A2A social.create_post stores 280 characters', async () => {
    createdPosts.length = 0;
    await FeedAgentExecutor.executeDirectly(
      'social.create_post',
      { content: atLimit },
      userId
    );
    expect(createdPosts).toEqual([{ content: atLimit }]);
  });

  test('A2A social.create_post rejects 281 characters without writing', async () => {
    createdPosts.length = 0;
    await expect(
      FeedAgentExecutor.executeDirectly(
        'social.create_post',
        { content: overLimit },
        userId
      )
    ).rejects.toThrow('content exceeds maximum length (280 chars)');
    expect(createdPosts).toHaveLength(0);
  });

  test('A2A social.send_message keeps the longer chat message limit', async () => {
    // Messages are not posts; a 1000-character message passes content
    // validation and reaches the participant check.
    await expect(
      FeedAgentExecutor.executeDirectly(
        'social.send_message',
        { chatId: 'chat-1', content: 'a'.repeat(1000) },
        userId
      )
    ).rejects.not.toThrow('maximum length');
  });
});
