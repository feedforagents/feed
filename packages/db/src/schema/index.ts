// Drizzle ORM Schema - Complete database schema for Feed
// This is the Drizzle schema

// Tables and Relations
export * from './achievements';
export * from './actor-state';
export * from './actors';
export * from './admin';
export * from './agents';
// NOTE: ElizaOS schema tables (packages/db/src/schema/eliza.ts) are intentionally
// NOT exported here. They are only referenced by drizzle.config.cjs so Drizzle Kit
// can manage their DDL. Exporting them here would pull @elizaos/plugin-sql into
// every bundle that imports @feed/db.
// Enums
export * from './enums';
export * from './markets';
export * from './mcp-oauth';
export * from './messaging';
export * from './misc';
export * from './narrative';
export * from './organization-state';
export * from './pools';
export * from './posts';
export * from './scambench';
export * from './sessions';
export * from './trading';
export * from './training';
export * from './user-agent-configs';
export * from './users';
export * from './users-relations';
export * from './wallet';
export * from './whitelist';
