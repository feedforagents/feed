import { dbWrite, sql } from '@feed/db';

export async function assertDisposableAgentFollowDatabase() {
  const raw = process.env.DATABASE_URL;
  if (
    !raw ||
    process.env.DIRECT_DATABASE_URL !== raw ||
    process.env.DATABASE_READ_REPLICA_URL?.trim()
  ) {
    throw new Error(
      'Agent follow tests require matching primary URLs and no replica'
    );
  }
  const target = URL.parse(raw);
  if (
    !target ||
    !['postgres:', 'postgresql:'].includes(target.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) ||
    !/^\/(?:test_db|feed_pr\d+)$/.test(target.pathname) ||
    target.search ||
    target.hash
  ) {
    throw new Error(
      'Agent follow tests require a disposable local PostgreSQL database'
    );
  }

  const [actual] = await dbWrite.execute<{
    database: string;
    role: string;
    host: string;
    port: number;
    primary: boolean;
  }>(
    sql`SELECT current_database() AS database, session_user AS role,
      host(inet_server_addr()) AS host, inet_server_port() AS port,
      NOT pg_is_in_recovery() AS primary`
  );
  const ciHost = process.env.FEED_TEST_POSTGRES_ADDRESS;
  const ciDatabase =
    process.env.CI === 'true' &&
    process.env.GITHUB_ACTIONS === 'true' &&
    target.pathname === '/test_db' &&
    target.username === 'postgres' &&
    target.port === '5432' &&
    ciHost &&
    actual?.host === ciHost;
  const localDatabase =
    /^\/feed_pr\d+$/.test(target.pathname) &&
    ['127.0.0.1', '::1'].includes(actual?.host ?? '');
  if (
    !actual ||
    actual.database !== target.pathname.slice(1) ||
    actual.role !== decodeURIComponent(target.username) ||
    actual.port !== Number(target.port || '5432') ||
    !actual.primary ||
    (!localDatabase && !ciDatabase)
  ) {
    throw new Error(
      'Agent follow tests refused an unexpected PostgreSQL backend'
    );
  }
}
