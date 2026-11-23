import { AsyncLocalStorage } from 'node:async_hooks';
import { getSurplusConfig, logger } from '@feed/shared';
import { and, eq, gte, isNull, or, sql } from 'drizzle-orm';
import { dbWrite, type Transaction } from './db';
import { scheduledInferenceReservations as reservations } from './schema/admin';

const utcDayStart = sql`date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
const budgetLock = sql`select pg_advisory_xact_lock(61512, 25)`;
const schedule = new AsyncLocalStorage<{
  limitMicroUsd: number;
  boundMicroUsd: number;
  upstream: URL;
}>();

function integerAmount(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const amount = Number(value);
  return Number.isSafeInteger(amount) ? amount : undefined;
}

async function readTotals(client: Pick<Transaction, 'select'>) {
  const [total] = await client
    .select({
      committed: sql<string>`coalesce(sum(coalesce(${reservations.costMicroUsd}, ${reservations.boundMicroUsd})), 0)`,
      breached: sql<boolean>`exists (
        select 1 from ${reservations}
        where ${reservations.costMicroUsd} > ${reservations.boundMicroUsd}
      )`,
    })
    .from(reservations)
    .where(
      or(
        isNull(reservations.settledAt),
        gte(reservations.settledAt, utcDayStart)
      )
    );
  const committed = Number(total?.committed);
  if (!total || !Number.isSafeInteger(committed) || committed < 0) {
    throw new Error('Scheduled inference budget totals are invalid');
  }
  return { committed, breached: total.breached };
}

export async function getScheduledInferenceThrottle() {
  const budget = schedule.getStore();
  if (!budget) return { exhausted: false, reduceBatch: false, maxSteps: 4 };
  const { committed, breached } = await readTotals(dbWrite);
  return {
    exhausted:
      breached || budget.boundMicroUsd > budget.limitMicroUsd - committed,
    reduceBatch: committed / budget.limitMicroUsd >= 0.8,
    maxSteps: committed / budget.limitMicroUsd >= 0.9 ? 2 : 4,
  };
}

/** Turn on the budget only for the scheduled world routes, with no provider fallback. */
export async function withScheduledInferenceBudget<T>(
  run: () => Promise<T>
): Promise<T> {
  const configured = process.env.NPC_LLM_DAILY_BUDGET_USD;
  if (configured === undefined || configured === '') return run();
  const parts = /^(\d+)(?:\.(\d{1,6}))?$/.exec(configured);
  const limitMicroUsd = parts?.[1]
    ? integerAmount(parts[1] + (parts[2] ?? '').padEnd(6, '0'))
    : undefined;
  if (!limitMicroUsd) {
    throw new Error(
      'NPC_LLM_DAILY_BUDGET_USD must be a positive amount in USD'
    );
  }
  const config = getSurplusConfig();
  if (!config)
    throw new Error('Budgeted scheduled inference requires a Surplus endpoint');
  const upstream = new URL(config.baseURL);
  const boundMicroUsd = integerAmount(
    process.env.SURPLUS_VERIFIED_MAX_REQUEST_MICRO_USD ?? ''
  );
  if (
    !boundMicroUsd ||
    upstream.username ||
    upstream.password ||
    (upstream.protocol !== 'https:' &&
      !(
        process.env.DEPLOYMENT_ENV === 'localnet' &&
        upstream.origin.startsWith('http://127.0.0.1:')
      ))
  ) {
    throw new Error(
      'Scheduled inference requires a verified per-request charge bound'
    );
  }
  return schedule.run({ limitMicroUsd, boundMicroUsd, upstream }, run);
}

/** At the HTTP boundary each SDK retry incurs a new reservation. */
export async function scheduledInferenceFetch(
  input: URL | RequestInfo,
  options?: RequestInit,
  unbudgetedFetch: (
    input: URL | RequestInfo,
    options?: RequestInit
  ) => Promise<Response> = fetch
): Promise<Response> {
  const budget = schedule.getStore();
  if (!budget) return unbudgetedFetch(input, options);
  const url = new URL(input instanceof Request ? input.url : input);
  const method = (
    options?.method ?? (input instanceof Request ? input.method : 'GET')
  ).toUpperCase();
  if (
    method !== 'POST' ||
    url.origin !== budget.upstream.origin ||
    !url.pathname.startsWith(`${budget.upstream.pathname.replace(/\/$/, '')}/`)
  ) {
    throw new Error(
      'Budgeted scheduled inference must use its configured provider endpoint'
    );
  }
  const id = crypto.randomUUID();
  const admitted = await dbWrite.transaction(async (tx) => {
    await tx.execute(budgetLock);
    const { committed, breached } = await readTotals(tx);
    if (breached || budget.boundMicroUsd > budget.limitMicroUsd - committed)
      return false;
    await tx
      .insert(reservations)
      .values({ id, boundMicroUsd: budget.boundMicroUsd });
    return true;
  });
  if (!admitted) {
    logger.warn(
      'Scheduled inference was declined by the daily cap',
      {},
      'InferenceBudget'
    );
    throw new Error('Scheduled inference budget exhausted or suspended');
  }
  let response: Response | undefined;
  try {
    response = await fetch(input, { ...options, redirect: 'error' });
  } finally {
    if (!response) {
      logger.warn(
        'Scheduled inference reservation remains pending after transport failure',
        { id },
        'InferenceBudget'
      );
    }
  }
  const costMicroUsd = integerAmount(
    response.headers.get('x-si-buyer-cost-micro') ?? ''
  );
  // Missing charge information and transport failures retain the full reservation.
  if (costMicroUsd !== undefined) {
    const [settled] = await dbWrite.transaction(async (tx) => {
      await tx.execute(budgetLock);
      // A response that crossed midnight needs the provider's accounting date.
      // Record an overrun immediately so that all workers stop regardless of its date.
      return tx
        .update(reservations)
        .set({ costMicroUsd, settledAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(reservations.id, id),
            isNull(reservations.settledAt),
            or(
              gte(reservations.createdAt, utcDayStart),
              sql`${costMicroUsd} > ${reservations.boundMicroUsd}`
            )
          )
        )
        .returning({ id: reservations.id });
    });
    if (!settled) {
      logger.warn(
        'Scheduled inference charge crosses the UTC boundary and needs reconciliation',
        { id },
        'InferenceBudget'
      );
    }
    if (costMicroUsd > budget.boundMicroUsd) {
      logger.error(
        'Scheduled inference provider exceeded the verified charge bound',
        { id, costMicroUsd },
        'InferenceBudget'
      );
      throw new Error(
        'Scheduled inference provider exceeded the verified charge bound'
      );
    }
  } else {
    logger.warn(
      'Scheduled inference returned without a confirmed charge',
      { id },
      'InferenceBudget'
    );
  }
  return response;
}
