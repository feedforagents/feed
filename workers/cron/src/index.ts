import { type CronJob, dueJobs, isCronJob } from './schedule';
import { getCronSkipReason } from './skip-reasons';

interface Env {
  APP: Fetcher;
  JOBS: Queue<CronJob>;
  APP_ORIGIN: string;
  CRON_SECRET: string;
  CRON_ENABLED: string;
  DEPLOYMENT_ENV?: string;
}

type DeliveryOutcome = {
  outcome: 'completed' | 'skipped' | 'failed' | 'unknown';
  skipReason?: string;
};

async function readOutcome(
  response: Response,
  path: string
): Promise<DeliveryOutcome> {
  // Consume the stream before acknowledging: completion can include deferred work.
  const body = await response.arrayBuffer();
  if (!response.ok) return { outcome: 'failed' };
  if (!response.headers.get('content-type')?.startsWith('application/json')) {
    return { outcome: 'unknown' };
  }

  try {
    const payload: unknown = JSON.parse(new TextDecoder().decode(body));
    if (payload && typeof payload === 'object') {
      if ('success' in payload && payload.success === false)
        return { outcome: 'failed' };
      if ('skipped' in payload && payload.skipped === true) {
        const skipReason =
          'reason' in payload
            ? getCronSkipReason(path, payload.reason)
            : undefined;
        return skipReason
          ? { outcome: 'skipped', skipReason }
          : { outcome: 'skipped' };
      }
      if ('success' in payload && payload.success === true)
        return { outcome: 'completed' };
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  return { outcome: 'unknown' };
}

export default {
  async scheduled(event: ScheduledController, env: Env) {
    if (env.CRON_ENABLED !== 'true') return;
    if (!env.CRON_SECRET) throw new Error('CRON_SECRET is required');
    const batch = dueJobs(
      event.scheduledTime,
      env.DEPLOYMENT_ENV === 'localnet'
    ).map(({ path }) => ({
      body: { path, scheduledTime: event.scheduledTime },
    }));
    if (batch.length) await env.JOBS.sendBatch(batch);
  },

  async queue(batch: MessageBatch<CronJob>, env: Env) {
    for (const message of batch.messages) {
      // Pause queued work as well as the producer during a cutover/rollback.
      if (env.CRON_ENABLED !== 'true') {
        message.retry({ delaySeconds: 300 });
        continue;
      }
      if (
        !env.CRON_SECRET ||
        !isCronJob(message.body, env.DEPLOYMENT_ENV === 'localnet')
      ) {
        throw new Error('Invalid cron configuration or queue message');
      }
      const { path, scheduledTime } = message.body;
      const startedAt = Date.now();
      let httpStatus: number | null = null;
      let delivery: DeliveryOutcome = { outcome: 'failed' };
      try {
        const response = await env.APP.fetch(
          new Request(new URL(path, env.APP_ORIGIN), {
            headers: {
              Authorization: `Bearer ${env.CRON_SECRET}`,
              'X-Cloudflare-Cron-Time': String(scheduledTime),
            },
            signal: AbortSignal.timeout(840_000),
          })
        );
        httpStatus = response.status;
        delivery = await readOutcome(response, path);
        if (!response.ok)
          throw new Error(`Cron ${path} returned HTTP ${response.status}`);
        message.ack();
      } finally {
        // biome-ignore lint/suspicious/noConsole: Cloudflare Workers Logs indexes this event.
        console.info({
          event: 'cron_delivery',
          job: path,
          scheduledTime,
          startedAt,
          finishedAt: Date.now(),
          attempt: message.attempts,
          httpStatus,
          ...delivery,
        });
      }
    }
  },
} satisfies ExportedHandler<Env, CronJob>;
