# Observability

Client and server instrumentation for operating Feed in production.

Related: error tracking and performance traces live in Sentry (see `.env.example`); product analytics in PostHog.

Cloudflare deployment logs are enabled in Wrangler. PostHog remains active when configured. Sentry is disabled during migration until Worker compatibility is verified.

For the [Phase 0 staging window](../product/mvp-plan.md#phase-0--get-the-world-running-p0-before-anything-else), filter `feed-cron-staging` Workers Logs to `event = cron_delivery`. Each record contains the route, scheduled time, start and finish times (UTC epoch milliseconds), delivery attempt, HTTP status, and the application-reported outcome. Compare the job and scheduled-time pairs with the expected slots in [the Worker schedule](../../workers/cron/src/schedule.ts). Use the same slot for all retries. A missed slot, failed attempt, or 2xx response with a skipped or unknown outcome cannot establish completion. For the same window, capture signed-out feed, market, and article updates and verify NPC inference routes through Surplus within the daily spend cap.
