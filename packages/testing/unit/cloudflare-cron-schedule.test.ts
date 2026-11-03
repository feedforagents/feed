import { describe, expect, test } from 'bun:test';
import { dueJobs, isCronJob, jobs } from '../../../workers/cron/src/schedule';

const at = (time: string) =>
  dueJobs(Date.parse(`2026-10-10T${time}:00Z`)).map((job) => job.path);

describe('Cloudflare cron schedule', () => {
  test('minute ticks are due independently of local timezone', () => {
    expect(at('12:01')).toEqual([
      '/api/cron/game-tick',
      '/api/cron/markets-tick',
      '/api/cron/realtime-drain',
    ]);
  });
  test('daily and funding boundaries are preserved', () => {
    expect(at('00:00')).toContain('/api/cron/whitelist-topn');
    expect(at('00:01')).not.toContain('/api/cron/whitelist-topn');
    expect(at('16:00')).toContain('/api/cron/perp-funding');
    expect(at('17:00')).not.toContain('/api/cron/perp-funding');
    expect(at('06:00')).toContain('/api/cron/world-facts');
    expect(at('18:00')).toContain('/api/cron/world-facts');
  });
  test.each(
    jobs.map(({ path }) => path)
  )('scheduled route %s exists', async (path) => {
    const route = new URL(
      `../../../apps/web/src/app${path}/route.ts`,
      import.meta.url
    );
    expect(await Bun.file(route).exists()).toBe(true);
  });
  test('all migrated jobs execute in a UTC day', () => {
    const seen = new Set<string>();
    const start = Date.parse('2026-10-10T00:00:00Z');
    for (let minute = 0; minute < 1440; minute++) {
      for (const job of dueJobs(start + minute * 60_000)) seen.add(job.path);
    }
    expect(seen.size).toBe(jobs.length);
  });
  test('queue messages cannot invoke arbitrary routes', () => {
    expect(isCronJob({ path: '/api/admin/delete', scheduledTime: 0 })).toBe(
      false
    );
    expect(isCronJob({ path: jobs[0].path, scheduledTime: Number.NaN })).toBe(
      false
    );
    expect(isCronJob({ path: jobs[0].path, scheduledTime: 0 })).toBe(true);
    for (const path of [
      '/api/cron/agent-tick',
      '/api/cron/reputation-sync',
      '/api/cron/profile-chain-sync',
    ]) {
      expect(isCronJob({ path, scheduledTime: 0 })).toBe(false);
    }
    expect(() => dueJobs(Number.NaN)).toThrow();
  });
});
