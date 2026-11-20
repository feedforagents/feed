// UTC cron schedules for all app cron routes (source of truth).
export const jobs = [
  { path: '/api/cron/metrics-snapshot', cron: '0 * * * *' },
  { path: '/api/cron/game-tick', cron: '* * * * *' },
  { path: '/api/cron/markets-tick', cron: '* * * * *' },
  { path: '/api/cron/npc-tick', cron: '*/2 * * * *' },
  { path: '/api/cron/organization-tick', cron: '*/5 * * * *' },
  { path: '/api/cron/article-tick', cron: '*/30 * * * *' },
  { path: '/api/cron/realtime-drain', cron: '* * * * *' },
  { path: '/api/cron/perp-funding', cron: '0 */8 * * *' },
  { path: '/api/cron/world-facts', cron: '0 6,18 * * *' },
  { path: '/api/cron/health-check', cron: '*/5 * * * *' },
  { path: '/api/cron/training-check', cron: '0 * * * *' },
  { path: '/api/cron/whitelist-topn', cron: '0 0 * * *' },
  { path: '/api/cron/notifications-digest', cron: '0 * * * *' },
  { path: '/api/cron/trading-fee-outbox', cron: '*/5 * * * *' },
] as const;

// Roll these paid jobs out only on the Phase 0 validation stack until D-25.
export const localnetJobs = [
  { path: '/api/cron/npc-tick?mode=groups', cron: '*/2 * * * *' },
  { path: '/api/cron/world-facts?mode=headlines', cron: '*/5 * * * *' },
] as const;

function matches(field: string, value: number): boolean {
  return field.split(',').some((entry) => {
    if (entry === '*') return true;
    if (/^\*\/[1-9]\d*$/.test(entry))
      return value % Number(entry.slice(2)) === 0;
    if (/^\d+$/.test(entry)) return value === Number(entry);
    throw new Error(`Unsupported cron field: ${entry}`);
  });
}

export function dueJobs(timestamp: number, localnet = false) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime()))
    throw new Error('Invalid schedule timestamp');
  const schedules = localnet ? [...jobs, ...localnetJobs] : jobs;
  return schedules.filter(({ cron }) => {
    const [minute, hour, day, month, weekday] = cron.split(' ');
    if (!minute || !hour || day !== '*' || month !== '*' || weekday !== '*') {
      throw new Error(`Unsupported schedule: ${cron}`);
    }
    return (
      matches(minute, date.getUTCMinutes()) && matches(hour, date.getUTCHours())
    );
  });
}

export interface CronJob {
  path: string;
  scheduledTime: number;
}

export function isCronJob(value: unknown, localnet = false): value is CronJob {
  if (
    !value ||
    typeof value !== 'object' ||
    !('path' in value) ||
    !('scheduledTime' in value)
  )
    return false;
  const schedules = localnet ? [...jobs, ...localnetJobs] : jobs;
  return (
    typeof value.scheduledTime === 'number' &&
    schedules.some((job) => job.path === value.path) &&
    Number.isFinite(value.scheduledTime)
  );
}
