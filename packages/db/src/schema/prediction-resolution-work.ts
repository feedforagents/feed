import { boolean, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { questions } from './markets';
import type { posts } from './posts';

export type PredictionResolutionDraft = {
  // Assign publish timestamps when this draft is inserted into Post.
  post: Omit<typeof posts.$inferInsert, 'timestamp' | 'createdAt'>;
  description: string;
  confidence: number;
  requiresManualReview: boolean;
  published?: boolean;
  recordWorldImpact?: boolean;
};

/** Recovery state and unpublished proof for one snapshot of a question. */
export const predictionResolutionWork = pgTable('PredictionResolutionWork', {
  questionId: text('questionId')
    .primaryKey()
    .references(() => questions.id, { onDelete: 'cascade' }),
  resolutionDate: timestamp('resolutionDate', { mode: 'date' }).notNull(),
  outcome: boolean('outcome').notNull(),
  nextAttemptAt: timestamp('nextAttemptAt', {
    withTimezone: true,
    mode: 'date',
  }),
  draft: jsonb('draft').$type<PredictionResolutionDraft>(),
});
