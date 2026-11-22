# Observability

Client and server instrumentation for operating Feed in production.

Related: error tracking and performance traces live in Sentry (see `.env.example`); product analytics in PostHog.

Cloudflare deployment logs are enabled in Wrangler. PostHog remains active when configured. Sentry is disabled during migration until Worker compatibility is verified.

For the [Phase 0 staging window](../product/mvp-plan.md#phase-0--get-the-world-running-p0-before-anything-else), filter `feed-cron-staging` Workers Logs to `event = cron_delivery`. Each record contains the route, scheduled time, start and finish times (UTC epoch milliseconds), delivery attempt, HTTP status, and the application-reported outcome. Compare the job and scheduled-time pairs with the expected slots in [the Worker schedule](../../workers/cron/src/schedule.ts). Use the same slot for all retries. A missed slot, failed attempt, or 2xx response with a skipped or unknown outcome cannot establish completion. For the same window, capture signed-out feed, market, and article updates and verify NPC inference routes through Surplus within the daily spend cap.

Before enabling the [D-25 spend cap](../product/prd.md#d-25-spend-enforcement), apply [the reservation migration](../../packages/db/drizzle/migrations/manual/0007_scheduled_inference_budget.sql) in a separate, reviewed transaction on the target database. The fee and funding migration runner does not apply it. Include the reservation table in the fresh baseline when regenerating it for Phase 1. Verify a provider-enforced maximum charge for each request made with the configured Surplus key across chat, embeddings, and image generation. Configure the maximum in micro-USD with `SURPLUS_VERIFIED_MAX_REQUEST_MICRO_USD` and enable the cap with `NPC_LLM_DAILY_BUDGET_USD=100` on all workers serving scheduled routes. Keep paid scheduled inference paused while the provider bound is unverified.

Each entry in `ScheduledInferenceReservation` carries a reserved maximum and, when available, a confirmed charge. The reservation remains pending if the response lacks a confirmed charge or crosses midnight. Compare pending entries with the provider's request logs before assigning a charge to a UTC day. A charge above the verified maximum suspends subsequent requests, including after midnight. Find declines and unresolved charges in server logs under `InferenceBudget`.

For market recovery on localnet, score `markets-tick` on its minute schedule
and use the pending count and oldest pending resolution age to measure backlog
drain. `markets-recovery` has its own delivery logs. Review held markets
separately from work eligible for automatic settlement. Apply
[the private work table migration](../../packages/db/drizzle/migrations/manual/0008_prediction_resolution_work.sql)
before enabling localnet recovery on an existing database. Hosted deployments
retain their market tick and admin review path. A hosted cutover requires the
private work table and verified shared D-25 spend enforcement.
