import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { users } from './users';

export const mcpOAuthClients = pgTable('McpOAuthClient', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  redirectUris: text('redirectUris').array().notNull(),
  createdAt: timestamp('createdAt', { mode: 'date', withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const mcpOAuthGrants = pgTable(
  'McpOAuthGrant',
  {
    id: text('id').primaryKey(),
    userId: text('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('clientId')
      .notNull()
      .references(() => mcpOAuthClients.id),
    scopes: text('scopes').array().notNull(),
    resource: text('resource').notNull(),
    expiresAt: timestamp('expiresAt', {
      mode: 'date',
      withTimezone: true,
    }).notNull(),
    revokedAt: timestamp('revokedAt', { mode: 'date', withTimezone: true }),
    createdAt: timestamp('createdAt', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp('lastUsedAt', { mode: 'date', withTimezone: true }),
  },
  (t) => [index('McpOAuthGrant_userId_idx').on(t.userId)]
);

export const mcpOAuthRequests = pgTable('McpOAuthRequest', {
  id: text('id').primaryKey(),
  userId: text('userId').references(() => users.id, { onDelete: 'cascade' }),
  clientId: text('clientId')
    .notNull()
    .references(() => mcpOAuthClients.id),
  redirectUri: text('redirectUri').notNull(),
  state: text('state').notNull(),
  challenge: text('challenge').notNull(),
  scopes: text('scopes').array().notNull(),
  resource: text('resource').notNull(),
  browserHash: text('browserHash').notNull(),
  expiresAt: timestamp('expiresAt', {
    mode: 'date',
    withTimezone: true,
  }).notNull(),
  consumedAt: timestamp('consumedAt', { mode: 'date', withTimezone: true }),
});

export const mcpOAuthTokens = pgTable(
  'McpOAuthToken',
  {
    hash: text('hash').primaryKey(),
    kind: text('kind').notNull(),
    grantId: text('grantId')
      .notNull()
      .references(() => mcpOAuthGrants.id, { onDelete: 'cascade' }),
    redirectUri: text('redirectUri'),
    challenge: text('challenge'),
    expiresAt: timestamp('expiresAt', {
      mode: 'date',
      withTimezone: true,
    }).notNull(),
    consumedAt: timestamp('consumedAt', { mode: 'date', withTimezone: true }),
  },
  (t) => [index('McpOAuthToken_grantId_idx').on(t.grantId)]
);

export const mcpOAuthAudit = pgTable(
  'McpOAuthAudit',
  {
    id: text('id').primaryKey(),
    userId: text('userId')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('clientId').notNull(),
    grantId: text('grantId').notNull(),
    event: text('event').notNull(),
    createdAt: timestamp('createdAt', { mode: 'date', withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('McpOAuthAudit_userId_createdAt_idx').on(t.userId, t.createdAt)]
);

export const mcpOAuthRateLimits = pgTable(
  'McpOAuthRateLimit',
  {
    key: text('key').primaryKey(),
    count: integer('count').notNull(),
    expiresAt: timestamp('expiresAt', {
      mode: 'date',
      withTimezone: true,
    }).notNull(),
  },
  (t) => [index('McpOAuthRateLimit_expiresAt_idx').on(t.expiresAt)]
);
