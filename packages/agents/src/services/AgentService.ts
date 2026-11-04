/** Shared persistence for NPC action logs. */
import { agentLogs, db } from '@feed/db';
import { generateSnowflakeId } from '../shared/snowflake';
import type { JsonValue } from '../types/common';

export class AgentService {
  async createLog(
    agentUserId: string,
    log: {
      type:
        | 'chat'
        | 'tick'
        | 'trade'
        | 'error'
        | 'system'
        | 'post'
        | 'comment'
        | 'dm'
        | 'like'
        | 'repost'
        | 'follow'
        | 'transfer';
      level: 'info' | 'warn' | 'error' | 'debug';
      message: string;
      prompt?: string;
      completion?: string;
      thinking?: string;
      metadata?: Record<string, JsonValue>;
    }
  ) {
    const result = await db
      .insert(agentLogs)
      .values({
        id: await generateSnowflakeId(),
        agentUserId,
        type: log.type,
        level: log.level,
        message: log.message,
        prompt: log.prompt ?? null,
        completion: log.completion ?? null,
        thinking: log.thinking ?? null,
        metadata: log.metadata
          ? JSON.parse(JSON.stringify(log.metadata))
          : null,
      })
      .returning();

    return result[0]!;
  }
}

export const agentService = new AgentService();
