/** Messaging actions require one explicit destination and exact message content. */
import type { Action } from '@elizaos/core';
import { z } from 'zod';
import { executeDirectMessage } from '../../../autonomous/DirectExecutors';
import {
  resolveGroupChatByName,
  resolveUserByUsername,
} from '../../../autonomous/utils/context-gatherers';
import type { FeedRuntime } from '../types';
import { clientFor, complete } from './contracts';

const id = z.string().trim().min(1);
const content = z
  .string()
  .refine((value) => value.trim().length > 0, 'Message content is required');
const sendParameters = z
  .object({
    chatId: id.optional(),
    recipientId: id.optional(),
    groupName: id.optional(),
    username: id.optional(),
    content,
  })
  .refine(
    (value) =>
      [value.chatId, value.recipientId, value.groupName, value.username].filter(
        (value) => value !== undefined
      ).length === 1,
    'Provide exactly one destination'
  );
export const sendMessageAction: Action = {
  name: 'SEND_MESSAGE',
  description:
    'Send exact content to one destination: chatId, recipientId, exact groupName, or username. Named groups must be unambiguous active memberships.',
  parameters: {
    chatId: {
      type: 'string',
      description: 'Exact existing chat ID',
      required: false,
    },
    recipientId: {
      type: 'string',
      description: 'Exact recipient ID for a DM',
      required: false,
    },
    groupName: {
      type: 'string',
      description: 'Exact group name',
      required: false,
    },
    username: {
      type: 'string',
      description: 'Exact recipient username',
      required: false,
    },
    content: {
      type: 'string',
      description: 'Exact message to send',
      required: true,
    },
  } as unknown as Action['parameters'],
  examples: [],
  validate: async (runtime) =>
    Boolean((runtime as FeedRuntime).a2aClient?.isConnected()),
  handler: async (runtime, _message, state, options, callback) => {
    const client = clientFor(runtime);
    const agentUserId = id.parse(client.agentId);
    const params = sendParameters.parse(
      options?.parameters ?? state?.data?.actionParams
    );
    let chatId = params.chatId;
    let recipientId = params.recipientId;
    if (params.groupName) {
      const resolved = await resolveGroupChatByName(
        agentUserId,
        params.groupName
      );
      if (!resolved)
        throw new Error(`No active group named ${params.groupName}`);
      chatId = resolved;
    }
    if (params.username) {
      const resolved = await resolveUserByUsername(params.username);
      if (!resolved) throw new Error(`Recipient not found: ${params.username}`);
      recipientId = resolved;
    }
    // This action deliberately uses the local authorized messaging executor for
    // both existing chats and new DMs; there is no transport fallback.
    const result = await executeDirectMessage({
      agentUserId,
      chatId,
      recipientId,
      content: params.content,
    });
    if (!result.success)
      throw new Error(result.error || 'Message delivery failed');
    const messageId = id.parse(result.messageId);
    return complete(
      'SEND_MESSAGE',
      {
        success: true,
        messageId,
        ...(chatId ? { chatId } : {}),
        ...(recipientId ? { recipientId } : {}),
      },
      callback
    );
  },
};
export const createGroupAction: Action = {
  name: 'CREATE_GROUP',
  description: 'Create a named group using explicit member IDs.',
  parameters: {
    name: { type: 'string', description: 'Exact group name', required: true },
    memberIds: {
      type: 'array',
      description: 'Explicit list of member IDs, excluding usernames',
      required: true,
    },
  } as unknown as Action['parameters'],
  examples: [],
  validate: async (runtime) =>
    Boolean((runtime as FeedRuntime).a2aClient?.isConnected()),
  handler: async (runtime, _message, state, _options, callback) => {
    const client = clientFor(runtime);
    const params = z
      .object({ name: id, memberIds: z.array(id) })
      .parse(state?.data?.actionParams);
    const raw = await client.createGroup(params.name, params.memberIds);
    if (
      raw &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      raw.success === false
    )
      return complete('CREATE_GROUP', raw, callback);
    z.object({
      success: z.literal(true),
      group: z.object({ id, chatId: id, name: id }),
    }).parse(raw);
    return complete('CREATE_GROUP', raw, callback);
  },
};
