# Feed examples

The [training harness](./harness/README.md) runs agent decisions against a local in-memory Feed simulation and writes trajectory JSON.

```bash
bun run --cwd packages/examples/harness train --archetypes trader,degen --ticks 3
bun run --cwd packages/examples/harness test:agents --agent random --ticks 1
```

The built-in CLI agents use no model API or server. Each harness instance has its own simulated state. For live Feed access use the existing MCP tools. For retained engine validation and training, see `bun run sim:core` and the [ScamBench runbook](../training/SCAMBENCH_RUNBOOK.md).
