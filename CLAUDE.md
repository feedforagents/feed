# Feed: Agent and Developer Rules

These rules apply to every AI coding agent (Claude Code, Codex, Cursor, Gemini
CLI, OpenCode, Hermes Agent, OpenClaw, elizaOS, and others) and to every human
contributor.

`AGENTS.md` and `CLAUDE.md` must stay byte-identical. Edit both in the same
commit. `.cursorrules` points to `CLAUDE.md`. Do not run `bun run ruler:apply`
for these files: the `.ruler/` sources are older, and Ruler overwrites
`AGENTS.md` and `CLAUDE.md`.

## PRD authority and required communication

All work is downstream of the [PRD](docs/product/prd.md). The
[MVP plan](docs/product/mvp-plan.md), issues, implementation approaches, code,
tests, documentation, and PR reviews must conform to its requirements and
non-goals. Follow the MVP phase dependencies and exit criteria; a passing test
or an open issue does not authorize a different product direction.

Before implementing any new feature or approach, update the PRD to describe
it and obtain maintainer approval of that change. Update the affected MVP
phase and acceptance criteria as well. Do not use an implementation or a PR
as retroactive approval. Existing defect fixes must cite the requirement they
restore; they must not silently introduce new scope.

At the start of every task, agents must reiterate to the user, in plain
language, what the relevant PRD sections say, cite those sections and the
applicable MVP phase, and explain how the proposed work follows them. Repeat
this when scope or approach changes. In the final handoff, restate the relevant
requirements and distinguish verified acceptance evidence from remaining work.
If requirements conflict or are missing, report that gap instead of inventing
scope or claiming MVP completion.

## Slop bounty rules

Feed is registered with [Slop](https://slop.cash). See the
[project page](https://slop.cash/projects/feed) for its current status and terms. Read
[CONTRIBUTING.md](CONTRIBUTING.md) before you select work. Summary:

1. **Star and fork first.** Star and fork `feedforagents/feed` with the
   contributor's own GitHub account. Slop uses this for tracking. Work from the
   fork. Open PRs into `staging`.
2. **Scope is binding.** All work must follow the PRD and MVP plan linked
   above. Cite the requirement and phase; new features or approaches require
   an approved PRD update before implementation. Never invent scope.
3. **Accepted work:** reproduced bugs, tests that prove real behavior,
   validation, security, measured quality improvements, and validation of the
   trading algorithm and simulations.
4. **Real LLM calls.** Use real inference for tests and evidence. Mocked or
   recorded LLM output is not proof.
5. **Environment.** Create a local `.env` from `.env.example`. Never commit it.
   CONTRIBUTING.md lists the variables for tests and validation.
6. **No UI changes.** No UI, visual, style, or copy changes. A fix for a broken
   user flow is the only exception, and it needs before and after video.
7. **Agent clients.** Test the real flow in more than one agent client. Record
   client name, version, provider, and model for each run.
8. **Not accepted:** cosmetic changes, preference refactors, speculative
   features, features without an approved PRD and MVP update, busywork tests,
   mock-only proof, placeholder or `TODO` code, unverified claims, duplicate
   PRs, and secrets in commits.
9. **PR evidence.** Link the issue or requirement. Give the root cause, the fix,
   real end-to-end evidence, test steps, expected results, and risks. Write in
   plain English.
10. **Rewards.** GitHub is the authority. Maintainers accept outcomes. Slop
    scores accepted merges. The monthly USDC pool is paid after maintainer
    review. Nothing is guaranteed or held in escrow.

Agents must not decide penalties or change contributor scores.

## Quality gate (run before every commit)

```bash
bun run check          # Biome format and lint (auto-fix)
bun run typecheck      # TypeScript across all packages
bun run lint           # Turbo lint (zero warnings)
bun run test:unit      # Unit tests
```

When your change touches the database or API:

```bash
bun run test:integration
```

When behavior depends on an LLM, run the live tests (needs `GROQ_API_KEY`,
`ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`):

```bash
bun run test:integration:live
```

Build before you say the work is done:

```bash
bun run build
```

## Architecture

### Dependency direction

`apps/* -> packages/* -> packages/contracts`

- **Apps are wiring only:** validate input, call a service, map errors, return
  a response.
- **Domain logic belongs in packages.** Keep it framework-agnostic: no Next,
  React, or Elysia imports in domain code.
- No circular dependencies between packages.

### Where to put code

| What | Where |
|---|---|
| Game logic and NPC decisions | `packages/engine` |
| Market pricing (prediction CPMM, perps) | `packages/core/markets` |
| Autonomous agents and ElizaOS plugins | `packages/agents` |
| A2A and MCP servers | `packages/a2a`, `packages/mcp` |
| Infra adapters (db, redis, http, sse, auth) | `packages/api`, `packages/db`, `packages/shared` |
| UI and route wiring | `apps/web` |
| Tests | `packages/testing` |

### Current state and target

- **Current:** Next.js `apps/web` hosts UI, API routes, SSE, A2A, and MCP. The
  CLI is in `apps/cli`. Domain code is in `packages/engine`, `packages/core`,
  and `packages/agents`.
- **Target (not approved scope for contributors):** Elysia host in
  `apps/server`, workers in `apps/daemon`, dedicated `apps/agents`, and domain
  split into `packages/core/*`. Do not start this migration without maintainer
  approval.

## Code standards

- Bun and TypeScript ESM, 2-space indent, minimal changes.
- No `any`. Avoid `unknown`; if you must use it, narrow it immediately.
- No broad `try/catch`. Catch only expected errors and map them at boundaries.
  Otherwise fail fast.
- Reuse before you build. Search for existing patterns and utilities first.
- No invented behavior. Do not add placeholders, synthetic data, or `TODO`
  stubs. Build the real thing, or do not submit it.
- Never commit API keys, private keys, or tokens. Never log sensitive values.
- When you add or change an environment variable, update `.env.example` with a
  comment (required or optional, and the default). Then run
  `bun run env:audit`.
- Keep changes scoped. Do not fix unrelated lint or format issues. Do not
  revert other work in progress.
- Do not create new docs or READMEs unless a maintainer asks. Update existing
  docs when behavior changes.

## Git conventions

- Default branch: `staging`.
- Commits: short, imperative, with a prefix (`feat:`, `fix:`, `chore:`,
  `refactor:`, `test:`, `docs:`).
- Run `bun run check` before you commit. Run `bun run typecheck` and
  `bun run lint` before you push.

## Testing

- Prefer integration tests for API, database, and infra flows
  (`packages/testing/integration`).
- Use unit tests for pure logic, such as pricing math, when they add confidence
  without heavy mocking (`packages/testing/unit`, package `__tests__`).
- Keep deterministic tests deterministic. Fakes and stubs are acceptable for
  isolation, but they are not evidence for LLM-dependent behavior.
- A skipped test is not evidence. Check the output.

## Commands

| Task | Command |
|---|---|
| Install | `bun install` |
| Dev (full) | `bun run dev` |
| Dev (web only) | `bun run dev:web` |
| Format and lint fix | `bun run check` |
| Typecheck | `bun run typecheck` |
| Lint | `bun run lint` |
| Build | `bun run build` |
| Unit tests | `bun run test:unit` |
| Integration tests | `bun run test:integration` |
| Live LLM integration tests | `bun run test:integration:live` |
| All optional integration tests | `bun run test:integration:all` |
| E2E tests | `bun run test:e2e` |
| Validate env | `bun run env:validate` |
| Audit env against code | `bun run env:audit` |
| DB generate / migrate / seed | `bun run db:generate`, `bun run db:migrate`, `bun run db:seed` |
| Regenerate agent skill docs | `bun run skills:generate` |

## Trading algorithm and simulation tools

Use these tools when you work on agent context, prompts, trading decisions, or
market generation. They run against the local database (no server needed,
except `tick:full`) and show what agents actually see and do.

```bash
# NPC trading context (sections, ghost variables, truncation)
bun run inspect:context -- --npc ailon-musk --type trading
bun run inspect:context -- --npc ailon-musk --type trading --raw
bun run inspect:context -- --agent <userId> --raw
bun run inspect:context -- --npc all --summary

# Compare two prompt versions with the same live context
bun scripts/prompt-diff.ts \
  --old "git:HEAD~1:packages/engine/src/prompts/trading/npc-market-decisions.ts" \
  --new packages/engine/src/prompts/trading/npc-market-decisions.ts

# Simulations and measurements
bun run sim:core -- --cycles 5            # report in runs/core-simulations/
bun run tick:full                         # needs the dev server on :3000
bun run report:realism -- --hours 24
bun run report:markets:health
bun run report:markets -- --history 7
```

For algorithm changes, measure before and after with the same inputs, provider,
and model. See CONTRIBUTING.md section 8.

Analysis documents: `docs/agent-context-analysis.md` and
`docs/stories-markets-analysis.md`.

## Production database (scale and locks)

Indexes and query shape are necessary but not sufficient. You cannot prove a
query is safe without runtime evidence (`EXPLAIN (ANALYZE)`,
`pg_stat_statements`, load tests).

- **Short transactions.** Hold locks for the minimum work. No network or LLM
  calls inside `db.transaction()`.
- **Pool and DB limits.** The app pool (`DATABASE_POOL_MAX` and related
  settings in `.env.example`) must stay below Postgres `max_connections`.
  Count PgBouncer, replicas, and workers. Defaults use small per-process pools.
- **Session guardrails.** In production, `packages/db` sets
  `statement_timeout`, `lock_timeout`, and
  `idle_in_transaction_session_timeout` on new connections (tunable by env).
- **DDL.** `CREATE INDEX` on large tables blocks writes unless you use
  `CONCURRENTLY`, which cannot run inside a transaction. Drizzle migrations
  block by default. The fresh baseline (`0000_fresh_baseline`) runs against
  an empty database, so its blocking indexes are fine. Later indexes on
  populated tables must use `CONCURRENTLY` in a hand-written migration outside
  a transaction.
- **Observability.** Enable `pg_stat_statements`. Watch `pg_locks` and
  `pg_stat_activity`. Alert on slow queries and connection saturation.
- **Read path.** Route read-heavy, latency-tolerant queries through
  `DATABASE_READ_REPLICA_URL` when it is set. Replicas can lag. Use the primary
  (`dbWrite`) when you must read your own write.
- **Lazy connections.** Database clients are created when a query runs, not on
  property access. With a read replica set, reads never create write clients.

Treat every new high-volume query as unsafe until you measure it with
production-like data volume.
