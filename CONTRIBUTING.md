# Contributing to Feed

Read the [branch README](README.md) before editing. The default integration
branch is `staging`. Use the contribution guide on your target branch and
submit changes to `main` when a maintainer requests them.

## Evidence

Include an `## Evidence` section in every PR. Start each field on its own line
with the exact name below. A Markdown bullet before the name is optional.
Use `Change types:` with `docs` alone for documentation-only changes. For
other work, list all applicable types from `non-ui`, `ui`, `performance`,
and `hardware`, separated by commas.

- `Test results:` Give the tested commit, environment, exact commands and
  outcomes. Link the run or attach the relevant output. Identify failed,
  skipped or blocked checks. For docs-only work, report the links and
  instructions you checked.
- `Proof of change:` Identify the affected supported workflow, why it matters
  and how to reproduce it. For fixes, show the failure on the base and success
  with the PR using the same inputs. For other changes, demonstrate the
  approved outcome and link the supporting evidence.
- `Runtime logs:` For non-UI changes, attach redacted API, Prisma database, or
  game daemon output from the affected workflow. Include the request or tick
  identifier and the resulting state. For contract changes, include
  `bun run contracts:test` results and a local or test-chain receipt if applicable.
- `UI video:` For a maintainer-approved broken-flow fix, attach base and PR
  recordings showing the full flow. Run the relevant `bun run test:e2e` or
  `bun run test:synpress` lane.
- `Benchmarks:` For performance changes, run the same game, route or query on
  the base and the PR with the same workload and data. Give latency or
  throughput, errors, and the spread across runs.
- `On-device testing:` For mobile handoff, embedded browser, wallet, or hardware
  changes, reproduce the complete flow on the affected supported physical
  device. Give the device model, OS, host or wallet version, and result.

Give exact commands and observed results inline or link to attachments,
job runs, or repository permalinks that reviewers can open. Each applicable
field requires substantive evidence. Blank fields, placeholders, and `N/A`
do not count. Redact credentials and private data from every attachment.
Update the evidence when changes to the PR head affect the result. Include
the signature supplied by the Slop.cash workflow on its submissions.

We close PRs that lack evidence of a useful change, including added complexity
for a highly unlikely path without evidence that it occurs in supported use
or threatens an existing requirement. For Slop.cash contributions, this also
costs the contributor points under the applicable points policy.
