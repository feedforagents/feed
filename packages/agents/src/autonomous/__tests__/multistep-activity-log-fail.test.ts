import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { agentService } from '../../services/AgentService';
import * as DirectExecutors from '../DirectExecutors';
import { MultiStepExecutor } from '../MultiStepExecutor';
import { Features } from '../templates/multi-step-decision';

/**
 * REPRO (candidate): MultiStepExecutor awaits agentService.createLog AFTER
 * the direct executor has committed the action, with no error guard — in
 * all 14 activity-log call sites (post, comment, like, repost, follow,
 * unfollow, reply-comment, reply-chat, DM, group message, create/invite/
 * kick/leave group). createLog does a real DB insert (generateSnowflakeId
 * + insert into agentLogs), so a transient DB failure throws. The throw
 * escapes executeAction, so execute() aborts the whole tick: the committed
 * action is never recorded in the trace, the trajectory step is never
 * recorded, and the remaining iterations are lost. A retry then double-posts,
 * double-likes, double-DMs, or recreates a group that already exists.
 *
 * This is the same post-commit bookkeeping class as open PR #1621, which
 * guards agentPnLService.recordTrade in DirectExecutors — but #1621 does
 * not cover the MultiStepExecutor wrappers, and the plugin-agent actions
 * cited there do not call createLog at all.
 *
 * Expected after fix: each wrapper resolves its committed result
 * ({ success: true, ... }) even when createLog throws; the logging
 * failure is only warned about.
 */

const logContext = {
  prompt: 'prompt',
  completion: 'completion',
  thought: 'thought',
};

describe('MultiStepExecutor activity-log failure', () => {
  afterEach(() => mock.restore());

  test('post stays successful when the activity log insert fails', async () => {
    spyOn(DirectExecutors, 'executeDirectPost').mockResolvedValue({
      success: true,
      postId: 'post-1',
    });
    spyOn(agentService, 'createLog').mockRejectedValue(
      new Error('DB unavailable')
    );

    const executor = new MultiStepExecutor();
    const result = await executor['executePost'](
      'agent-1',
      { content: 'hello world, this is a post' },
      logContext
    );

    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({ postId: 'post-1' });
  });

  test('like stays successful when the activity log insert fails', async () => {
    spyOn(DirectExecutors, 'executeDirectLike').mockResolvedValue({
      success: true,
      liked: true,
    });
    spyOn(agentService, 'createLog').mockRejectedValue(
      new Error('DB unavailable')
    );

    const executor = new MultiStepExecutor();
    const result = await executor['executeLike']('agent-1', {
      postId: 'post-1',
    });

    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({ liked: true });
  });

  test('failed like keeps its original error when the log insert fails', async () => {
    spyOn(DirectExecutors, 'executeDirectLike').mockResolvedValue({
      success: false,
      error: 'Post not found: post-1',
    });
    spyOn(agentService, 'createLog').mockRejectedValue(
      new Error('DB unavailable')
    );

    const executor = new MultiStepExecutor();
    const result = await executor['executeLike']('agent-1', {
      postId: 'post-1',
    });

    expect(result.success).toBe(false);
    expect(result.summary).toContain('Post not found: post-1');
  });

  test('DM stays successful when the activity log insert fails', async () => {
    spyOn(DirectExecutors, 'executeDirectMessage').mockResolvedValue({
      success: true,
      messageId: 'msg-1',
    });
    spyOn(agentService, 'createLog').mockRejectedValue(
      new Error('DB unavailable')
    );

    const executor = new MultiStepExecutor();
    const result = await executor['executeDM'](
      'agent-1',
      { recipientId: 'user-2', content: 'hello there' },
      logContext
    );

    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({ messageId: 'msg-1' });
  });

  test('create-group stays successful when the activity log insert fails', async () => {
    spyOn(DirectExecutors, 'executeDirectCreateGroup').mockResolvedValue({
      success: true,
      groupId: 'group-1',
      chatId: 'chat-1',
    });
    spyOn(agentService, 'createLog').mockRejectedValue(
      new Error('DB unavailable')
    );

    const executor = new MultiStepExecutor();
    const result = await executor['executeCreateGroup'](
      'agent-1',
      { name: 'test group' },
      logContext
    );

    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({ groupId: 'group-1' });
  });

  test('executeAction does not throw the tick away when logging fails', async () => {
    spyOn(DirectExecutors, 'executeDirectPost').mockResolvedValue({
      success: true,
      postId: 'post-1',
    });
    spyOn(agentService, 'createLog').mockRejectedValue(
      new Error('DB unavailable')
    );

    const executor = new MultiStepExecutor();
    const result = await executor['executeAction'](
      'agent-1',
      'POST',
      { content: 'hello world, this is a post' },
      [Features.POSTING],
      undefined,
      true,
      logContext
    );

    expect(result.success).toBe(true);
    expect(result.actionType).toBe('POST');
  });
});
